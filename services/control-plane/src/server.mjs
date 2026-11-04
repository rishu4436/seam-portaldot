import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { ControlStore, equalToken, SCOPES } from "./store.mjs";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const object = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const label = (value) => {
  if (typeof value !== "string" || !value.trim() || value.length > 100)
    throw new HttpError(400, "A name of 1–100 characters is required.");
  return value.trim();
};
const SECRET_KEYS =
  /^(?:__proto__|prototype|constructor|seed|mnemonic|suri|privateKey|secret|authorization|accessKey|signedTx|signedExtrinsics?|signedBytes|signature|metadataHex|preparedMetadataHex|currentMetadataHex)$/i;
export function validateBundle(bundle) {
  if (
    !object(bundle) ||
    bundle.bundleVersion !== 1 ||
    !object(bundle.receipt) ||
    !object(bundle.plan)
  )
    throw new HttpError(400, "Expected a version-1 evidence bundle with receipt and plan.");
  if (
    Object.keys(bundle).some(
      (key) =>
        ![
          "bundleVersion",
          "createdAt",
          "receipt",
          "plan",
          "manifest",
          "runtime",
          "effects",
          "abis",
        ].includes(key),
    )
  )
    throw new HttpError(400, "Unrecognized evidence-bundle field.");
  const stack = [{ value: bundle, depth: 0 }];
  let visited = 0;
  while (stack.length) {
    const { value, depth } = stack.pop();
    if (++visited > 20000 || depth > 24)
      throw new HttpError(400, "Evidence structure is too complex.");
    if (typeof value === "string" && /^seam_(?:root|key)_/.test(value))
      throw new HttpError(400, "Access keys must never be stored in evidence.");
    if (value && typeof value === "object")
      for (const [key, item] of Object.entries(value)) {
        if (SECRET_KEYS.test(key))
          throw new HttpError(400, `Evidence contains a forbidden field: ${key}.`);
        stack.push({ value: item, depth: depth + 1 });
      }
  }
  if (
    !Array.isArray(bundle.plan.steps) ||
    bundle.plan.steps.length < 1 ||
    bundle.plan.steps.length > 16
  )
    throw new HttpError(400, "Evidence supports 1–16 planned steps.");
  return bundle;
}

async function readJson(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] ?? ""))
    throw new HttpError(415, "Use application/json.");
  const max = 512 * 1024;
  if (Number(req.headers["content-length"]) > max)
    throw new HttpError(413, "Request exceeds 512 KiB.");
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > max) throw new HttpError(413, "Request exceeds 512 KiB.");
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!object(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, "Expected a JSON object.");
  }
}

export function createControlPlane({
  database = ":memory:",
  bootstrapToken,
  origins = [],
  runtime,
  verify,
  worker = true,
  backups,
  log = () => {},
}) {
  if (typeof bootstrapToken !== "string" || bootstrapToken.length < 32)
    throw new Error("SEAM_BOOTSTRAP_TOKEN must have at least 32 characters.");
  const store = new ControlStore(database);
  const buckets = new Map();
  let working = false,
    verifying = false;
  function limit(key, maximum) {
    const minute = Math.floor(Date.now() / 60000),
      previous = buckets.get(key);
    const bucket = previous?.minute === minute ? previous : { minute, count: 0 };
    if (++bucket.count > maximum)
      throw new HttpError(429, "Rate limit reached. Try again in one minute.");
    buckets.set(key, bucket);
    if (buckets.size > 10000)
      for (const [k, b] of buckets) if (b.minute !== minute) buckets.delete(k);
  }
  async function runMonitor(monitor) {
    if (!store.leaseMonitor(monitor.id)) throw new HttpError(409, "A check is already running.");
    let status, detail;
    try {
      const current = await runtime(),
        baseline = JSON.parse(monitor.baseline);
      const changed = [
        "genesisHash",
        "specName",
        "specVersion",
        "transactionVersion",
        "layoutHash",
      ].filter((key) => current[key] !== baseline[key]);
      status = changed.length ? "changed" : "unchanged";
      detail = {
        current,
        baseline,
        changed,
        metadataOnlyDrift: !changed.length && current.metadataHash !== baseline.metadataHash,
      };
    } catch (error) {
      status = "unknown";
      detail = { message: String(error.message).slice(0, 300) };
    }
    store.saveCheck(monitor.id, status, detail);
    return { status, detail };
  }
  async function tick() {
    if (working) return;
    working = true;
    try {
      for (const monitor of store.due()) await runMonitor(monitor);
    } catch (error) {
      log({ event: "worker_error", message: String(error.message).slice(0, 200) });
    } finally {
      working = false;
    }
  }
  const timer = worker ? setInterval(() => void tick(), 15000) : undefined;
  timer?.unref();
  const server = createServer(
    { maxHeaderSize: 8192, requestTimeout: 15000, headersTimeout: 10000 },
    async (req, res) => {
      const requestId = randomUUID();
      const send = (status, body) => {
        res.writeHead(status, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "x-request-id": requestId,
          "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
        });
        res.end(JSON.stringify(body));
      };
      try {
        const origin = req.headers.origin;
        if (origin) {
          if (!origins.includes(origin)) throw new HttpError(403, "This origin is not allowed.");
          res.setHeader("Access-Control-Allow-Origin", origin);
          res.setHeader("Vary", "Origin");
          res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
          res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
          res.setHeader("Access-Control-Max-Age", "600");
        }
        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }
        limit(`ip:${req.socket.remoteAddress}`, 600);
        const path = new URL(req.url, "http://service.internal").pathname;
        if (req.method === "GET" && path === "/healthz") {
          store.db.prepare("SELECT 1").get();
          return send(200, { status: "ok", service: "seam-control-plane", version: 1 });
        }
        const token = /^Bearer ([A-Za-z0-9_-]{32,160})$/.exec(req.headers.authorization ?? "")?.[1];
        if (!token) throw new HttpError(401, "A valid bearer access key is required.");
        const root = equalToken(token, bootstrapToken);
        const actor = root
          ? { id: "bootstrap", name: "Administrator", scopes: SCOPES }
          : store.authenticate(token);
        if (!actor) throw new HttpError(401, "The access key is invalid or revoked.");
        limit(`actor:${actor.id}`, 120);
        if (req.method === "GET" && path === "/v1/session")
          return send(200, {
            name: actor.name,
            keyId: actor.id,
            workspaceId: actor.workspaceId ?? null,
            scopes: actor.scopes,
            administrator: root,
          });
        if (path === "/v1/operations/backups") {
          if (!root) throw new HttpError(403, "Only the operator can manage service backups.");
          const manager = backups?.();
          if (req.method === "GET")
            return send(200, manager?.status() ?? { enabled: false, status: "disabled" });
          if (req.method === "POST") {
            if (!manager) throw new HttpError(503, "Service backups are not configured.");
            return send(200, await manager.run());
          }
          throw new HttpError(405, "Method not allowed.");
        }
        if (root && req.method === "GET" && path === "/v1/workspaces")
          return send(200, {
            workspaces: store.db
              .prepare("SELECT * FROM workspaces ORDER BY created_at DESC LIMIT 100")
              .all(),
          });
        if (root && req.method === "POST" && path === "/v1/workspaces")
          return send(201, store.createWorkspace(label((await readJson(req)).name)));
        const route = /^\/v1\/workspaces\/([\w-]+)(?:\/(.*))?$/.exec(path);
        if (!route) throw new HttpError(404, "Route not found.");
        const [, workspaceId, resource = ""] = route;
        if (!root && actor.workspaceId !== workspaceId)
          throw new HttpError(403, "This access key cannot access that workspace.");
        if (!store.db.prepare("SELECT id FROM workspaces WHERE id=?").get(workspaceId))
          throw new HttpError(404, "Workspace not found.");
        const requireScope = (scope) => {
          if (!actor.scopes.includes(scope))
            throw new HttpError(403, `This action requires ${scope}.`);
        };
        if (resource === "keys" && req.method === "GET") {
          requireScope("keys:write");
          return send(200, { keys: store.keys(workspaceId) });
        }
        if (resource === "keys" && req.method === "POST") {
          requireScope("keys:write");
          const body = await readJson(req);
          const scopes = body.scopes ?? ["evidence:read", "monitor:read"];
          if (
            !Array.isArray(scopes) ||
            !scopes.length ||
            scopes.some((s) => !SCOPES.includes(s) || !actor.scopes.includes(s))
          )
            throw new HttpError(400, "Invalid access-key scopes.");
          if (store.keys(workspaceId).filter((k) => !k.revoked_at).length >= 50)
            throw new HttpError(409, "Active key quota reached (50).");
          return send(
            201,
            store.createKey(workspaceId, label(body.name), [...new Set(scopes)], actor.id),
          );
        }
        const revoke = /^keys\/([\w-]+)\/revoke$/.exec(resource);
        if (revoke && req.method === "POST") {
          requireScope("keys:write");
          if (!store.revokeKey(workspaceId, revoke[1], actor.id))
            throw new HttpError(404, "Active key not found.");
          return send(200, { revoked: true });
        }
        if (resource === "audit" && req.method === "GET") {
          requireScope("keys:write");
          return send(200, { audit: store.auditLog(workspaceId) });
        }
        if (resource === "export" && req.method === "GET") {
          requireScope("keys:write");
          return send(200, store.export(workspaceId));
        }
        if (resource === "evidence" && req.method === "GET") {
          requireScope("evidence:read");
          return send(200, { evidence: store.listEvidence(workspaceId) });
        }
        if (resource === "evidence" && req.method === "POST") {
          requireScope("evidence:write");
          const body = await readJson(req);
          return send(
            201,
            store.addEvidence(workspaceId, label(body.name), validateBundle(body.bundle), actor.id),
          );
        }
        const evidence = /^evidence\/([\w-]+)(?:\/(verify))?$/.exec(resource);
        if (evidence) {
          requireScope(evidence[2] ? "evidence:write" : "evidence:read");
          const saved = store.evidence(workspaceId, evidence[1]);
          if (!saved) throw new HttpError(404, "Evidence not found.");
          if (!evidence[2] && req.method === "GET") return send(200, saved);
          if (evidence[2] && req.method === "POST") {
            limit(`verify:${workspaceId}`, 10);
            if (verifying)
              throw new HttpError(429, "A verification is already running. Try again shortly.");
            verifying = true;
            try {
              let result;
              try {
                result = await verify(saved.bundle);
              } catch {
                result = {
                  status: "unknown",
                  notes: [
                    "The independent verification could not complete. Retry when the testnet node is available.",
                  ],
                };
                log({ event: "verification_unavailable", requestId });
              }
              result = { ...result, checkedAt: new Date().toISOString() };
              store.saveVerification(workspaceId, saved.id, result, actor.id);
              return send(200, result);
            } finally {
              verifying = false;
            }
          }
        }
        if (resource === "monitors" && req.method === "GET") {
          requireScope("monitor:read");
          return send(200, { monitors: store.monitors(workspaceId) });
        }
        if (resource === "monitors" && req.method === "POST") {
          requireScope("monitor:write");
          const body = await readJson(req);
          if (
            !Number.isInteger(body.intervalSeconds) ||
            body.intervalSeconds < 300 ||
            body.intervalSeconds > 86400
          )
            throw new HttpError(400, "Monitor intervals must be 300–86400 seconds.");
          return send(
            201,
            store.createMonitor(
              workspaceId,
              label(body.name),
              body.intervalSeconds,
              await runtime(),
              actor.id,
            ),
          );
        }
        const monitor = /^monitors\/([\w-]+)(?:\/(check))?$/.exec(resource);
        if (monitor) {
          requireScope(req.method === "GET" ? "monitor:read" : "monitor:write");
          const saved = store.monitor(workspaceId, monitor[1]);
          if (!saved) throw new HttpError(404, "Monitor not found.");
          if (req.method === "GET" && !monitor[2])
            return send(200, {
              monitor: { ...saved, baseline: JSON.parse(saved.baseline) },
              checks: store.checks(saved.id),
            });
          if (req.method === "POST" && monitor[2]) return send(200, await runMonitor(saved));
          if (req.method === "PATCH" && !monitor[2]) {
            const body = await readJson(req);
            if (typeof body.enabled !== "boolean")
              throw new HttpError(400, "enabled must be true or false.");
            store.setMonitorEnabled(workspaceId, saved.id, body.enabled, actor.id);
            return send(200, { enabled: body.enabled });
          }
        }
        throw new HttpError(404, "Route not found.");
      } catch (error) {
        const status =
          error instanceof HttpError
            ? error.status
            : /quota reached/i.test(error.message)
              ? 409
              : 500;
        log({ event: "request_error", requestId, status });
        if (!res.headersSent)
          send(status, {
            error:
              status === 500
                ? "The operation could not complete. Retry using the request ID."
                : error.message,
            requestId,
          });
        else res.end();
      }
    },
  );
  return {
    server,
    store,
    tick,
    close: async () => {
      if (timer) clearInterval(timer);
      await new Promise((resolve) => server.close(resolve));
      store.close();
    },
  };
}
