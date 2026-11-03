import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export const SCOPES = [
  "evidence:read",
  "evidence:write",
  "monitor:read",
  "monitor:write",
  "keys:write",
];
export const hashToken = (token) => createHash("sha256").update(token).digest("hex");
export const newKey = () => `seam_key_${randomBytes(32).toString("base64url")}`;
export const equalToken = (a, b) =>
  timingSafeEqual(Buffer.from(hashToken(a), "hex"), Buffer.from(hashToken(b), "hex"));

export class ControlStore {
  constructor(path) {
    this.db = new DatabaseSync(path, { timeout: 5000, defensive: true });
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA foreign_keys=ON;
      PRAGMA trusted_schema=OFF;
      CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS access_keys(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, prefix TEXT NOT NULL, scopes TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT) STRICT;
      CREATE TABLE IF NOT EXISTS evidence(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL, content_hash TEXT NOT NULL, bundle TEXT NOT NULL, verification TEXT, created_at TEXT NOT NULL, verified_at TEXT, UNIQUE(workspace_id, content_hash)) STRICT;
      CREATE TABLE IF NOT EXISTS monitors(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), name TEXT NOT NULL, interval_seconds INTEGER NOT NULL, baseline TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, next_run INTEGER NOT NULL, lease_until INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS monitor_checks(id TEXT PRIMARY KEY, monitor_id TEXT NOT NULL REFERENCES monitors(id), status TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
      CREATE INDEX IF NOT EXISTS due_monitors ON monitors(enabled,next_run);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
    `);
  }
  close() {
    this.db.close();
  }
  audit(workspaceId, actor, action, target) {
    this.db
      .prepare("INSERT INTO audit(workspace_id,actor,action,target,created_at) VALUES(?,?,?,?,?)")
      .run(workspaceId, actor, action, target, new Date().toISOString());
    this.db
      .prepare(
        "DELETE FROM audit WHERE workspace_id=? AND id NOT IN (SELECT id FROM audit WHERE workspace_id=? ORDER BY id DESC LIMIT 5000)",
      )
      .run(workspaceId, workspaceId);
  }
  createWorkspace(name) {
    if (this.db.prepare("SELECT count(*) AS n FROM workspaces").get().n >= 10)
      throw new Error("Workspace quota reached (10).");
    const id = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO workspaces VALUES(?,?,?)")
        .run(id, name, new Date().toISOString());
      const key = this.createKey(id, "Workspace owner", SCOPES, "bootstrap");
      this.db.exec("COMMIT");
      return { id, name, ...key };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  createKey(workspaceId, name, scopes, actor) {
    const token = newKey(),
      id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO access_keys(id,workspace_id,name,token_hash,prefix,scopes,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        id,
        workspaceId,
        name,
        hashToken(token),
        token.slice(0, 16),
        JSON.stringify(scopes),
        new Date().toISOString(),
      );
    this.audit(workspaceId, actor, "key.created", id);
    return { accessKey: token, keyId: id };
  }
  authenticate(token) {
    const key = this.db
      .prepare(
        "SELECT id,workspace_id,name,scopes FROM access_keys WHERE token_hash=? AND revoked_at IS NULL",
      )
      .get(hashToken(token));
    return key
      ? {
          id: key.id,
          workspaceId: key.workspace_id,
          name: key.name,
          scopes: JSON.parse(key.scopes),
        }
      : undefined;
  }
  keys(workspaceId) {
    return this.db
      .prepare(
        "SELECT id,name,prefix,scopes,created_at,revoked_at FROM access_keys WHERE workspace_id=? ORDER BY created_at DESC",
      )
      .all(workspaceId)
      .map((k) => ({ ...k, scopes: JSON.parse(k.scopes) }));
  }
  revokeKey(workspaceId, id, actor) {
    const result = this.db
      .prepare(
        "UPDATE access_keys SET revoked_at=? WHERE workspace_id=? AND id=? AND revoked_at IS NULL",
      )
      .run(new Date().toISOString(), workspaceId, id);
    if (result.changes) this.audit(workspaceId, actor, "key.revoked", id);
    return !!result.changes;
  }
  listEvidence(workspaceId) {
    return this.db
      .prepare(
        "SELECT id,name,content_hash,verification,created_at,verified_at FROM evidence WHERE workspace_id=? ORDER BY created_at DESC LIMIT 500",
      )
      .all(workspaceId)
      .map((e) => ({ ...e, verification: e.verification ? JSON.parse(e.verification) : null }));
  }
  evidence(workspaceId, id) {
    const e = this.db
      .prepare("SELECT * FROM evidence WHERE workspace_id=? AND id=?")
      .get(workspaceId, id);
    return e
      ? {
          ...e,
          bundle: JSON.parse(e.bundle),
          verification: e.verification ? JSON.parse(e.verification) : null,
        }
      : undefined;
  }
  addEvidence(workspaceId, name, bundle, actor) {
    const text = JSON.stringify(bundle),
      hash = hashToken(text);
    const existing = this.db
      .prepare("SELECT id FROM evidence WHERE workspace_id=? AND content_hash=?")
      .get(workspaceId, hash);
    if (existing) return { id: existing.id, duplicate: true };
    if (
      this.db
        .prepare("SELECT coalesce(sum(length(bundle)),0) AS n FROM evidence WHERE workspace_id=?")
        .get(workspaceId).n +
        text.length >
      64 * 1024 * 1024
    )
      throw new Error("Workspace storage quota reached (64 MiB).");
    if (
      this.db.prepare("SELECT count(*) AS n FROM evidence WHERE workspace_id=?").get(workspaceId)
        .n >= 500
    )
      throw new Error(
        "Workspace evidence quota reached (500). Export your evidence before adding more.",
      );
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO evidence(id,workspace_id,name,content_hash,bundle,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(id, workspaceId, name, hash, text, new Date().toISOString());
    this.audit(workspaceId, actor, "evidence.stored", id);
    return { id, duplicate: false };
  }
  saveVerification(workspaceId, id, result, actor) {
    this.db
      .prepare("UPDATE evidence SET verification=?,verified_at=? WHERE workspace_id=? AND id=?")
      .run(JSON.stringify(result), new Date().toISOString(), workspaceId, id);
    this.audit(workspaceId, actor, "evidence.verified", id);
  }
  monitors(workspaceId) {
    return this.db
      .prepare(
        "SELECT id,name,interval_seconds,baseline,enabled,next_run,created_at FROM monitors WHERE workspace_id=? ORDER BY created_at DESC LIMIT 50",
      )
      .all(workspaceId)
      .map((m) => ({
        ...m,
        baseline: JSON.parse(m.baseline),
        latest: this.checks(m.id)[0] ?? null,
      }));
  }
  monitor(workspaceId, id) {
    return this.db
      .prepare("SELECT * FROM monitors WHERE workspace_id=? AND id=?")
      .get(workspaceId, id);
  }
  createMonitor(workspaceId, name, interval, baseline, actor) {
    if (
      this.db.prepare("SELECT count(*) AS n FROM monitors WHERE workspace_id=?").get(workspaceId)
        .n >= 50
    )
      throw new Error("Workspace monitor quota reached (50).");
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO monitors(id,workspace_id,name,interval_seconds,baseline,next_run,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        id,
        workspaceId,
        name,
        interval,
        JSON.stringify(baseline),
        Date.now(),
        new Date().toISOString(),
      );
    this.audit(workspaceId, actor, "monitor.created", id);
    return { id };
  }
  setMonitorEnabled(workspaceId, id, enabled, actor) {
    const result = this.db
      .prepare("UPDATE monitors SET enabled=? WHERE workspace_id=? AND id=?")
      .run(enabled ? 1 : 0, workspaceId, id);
    if (result.changes)
      this.audit(workspaceId, actor, enabled ? "monitor.enabled" : "monitor.paused", id);
    return !!result.changes;
  }
  leaseMonitor(id) {
    const now = Date.now();
    return !!this.db
      .prepare(
        "UPDATE monitors SET lease_until=?,next_run=?+interval_seconds*1000 WHERE id=? AND lease_until<?",
      )
      .run(now + 60000, now, id, now).changes;
  }
  due() {
    return this.db
      .prepare(
        "SELECT * FROM monitors WHERE enabled=1 AND next_run<=? AND lease_until<? ORDER BY next_run LIMIT 2",
      )
      .all(Date.now(), Date.now());
  }
  saveCheck(monitorId, status, detail) {
    this.db
      .prepare("INSERT INTO monitor_checks VALUES(?,?,?,?,?)")
      .run(randomUUID(), monitorId, status, JSON.stringify(detail), new Date().toISOString());
    this.db.prepare("UPDATE monitors SET lease_until=0 WHERE id=?").run(monitorId);
    this.db
      .prepare(
        "DELETE FROM monitor_checks WHERE monitor_id=? AND id NOT IN (SELECT id FROM monitor_checks WHERE monitor_id=? ORDER BY created_at DESC LIMIT 100)",
      )
      .run(monitorId, monitorId);
  }
  checks(id) {
    return this.db
      .prepare(
        "SELECT id,status,detail,created_at FROM monitor_checks WHERE monitor_id=? ORDER BY created_at DESC LIMIT 100",
      )
      .all(id)
      .map((c) => ({ ...c, detail: JSON.parse(c.detail) }));
  }
  auditLog(workspaceId) {
    return this.db
      .prepare(
        "SELECT actor,action,target,created_at FROM audit WHERE workspace_id=? ORDER BY id DESC LIMIT 200",
      )
      .all(workspaceId);
  }
  export(workspaceId) {
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      workspace: this.db.prepare("SELECT * FROM workspaces WHERE id=?").get(workspaceId),
      evidence: this.listEvidence(workspaceId).map((e) => this.evidence(workspaceId, e.id)),
      monitors: this.monitors(workspaceId).map((m) => ({ ...m, checks: this.checks(m.id) })),
      audit: this.auditLog(workspaceId),
    };
  }
}
