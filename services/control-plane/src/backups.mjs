import { backup, DatabaseSync } from "node:sqlite";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const MAGIC = Buffer.from("SEAMBACKUP1\n");
const MAXIMUM = 128 * 1024 * 1024;
const TABLES = ["workspaces", "access_keys", "evidence", "monitors", "monitor_checks", "audit"];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function parseKey(value) {
  if (typeof value !== "string" || !/^[a-f\d]{64}$/i.test(value))
    throw new Error("A 32-byte hexadecimal backup encryption key is required.");
  return Buffer.from(value, "hex");
}
export function encryptBackup(bytes, keyValue) {
  const key = parseKey(keyValue),
    iv = randomBytes(12),
    keyId = Buffer.from(digest(key).slice(0, 16));
  const header = Buffer.concat([MAGIC, keyId]);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(header);
  const payload = gzipSync(
    Buffer.from(
      JSON.stringify({
        version: 1,
        createdAt: new Date().toISOString(),
        sha256: digest(bytes),
        database: bytes.toString("base64"),
      }),
    ),
  );
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  return Buffer.concat([header, iv, cipher.getAuthTag(), encrypted]);
}
export function decryptBackup(bytes, keyValue) {
  const key = parseKey(keyValue),
    headerLength = MAGIC.length + 16;
  if (
    bytes.length > MAXIMUM ||
    bytes.length < headerLength + 29 ||
    !bytes.subarray(0, MAGIC.length).equals(MAGIC)
  )
    throw new Error("Invalid or oversized SEAM backup.");
  if (bytes.subarray(MAGIC.length, headerLength).toString() !== digest(key).slice(0, 16))
    throw new Error("Backup encryption key does not match.");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    bytes.subarray(headerLength, headerLength + 12),
  );
  decipher.setAAD(bytes.subarray(0, headerLength));
  decipher.setAuthTag(bytes.subarray(headerLength + 12, headerLength + 28));
  const plain = Buffer.concat([
    decipher.update(bytes.subarray(headerLength + 28)),
    decipher.final(),
  ]);
  const value = JSON.parse(gunzipSync(plain, { maxOutputLength: MAXIMUM }).toString("utf8"));
  if (value.version !== 1 || typeof value.database !== "string")
    throw new Error("Unsupported backup version.");
  const database = Buffer.from(value.database, "base64");
  if (
    digest(database) !== value.sha256 ||
    database.subarray(0, 16).toString() !== "SQLite format 3\0"
  )
    throw new Error("Backup database checksum failed.");
  return { database, createdAt: value.createdAt, sha256: value.sha256 };
}
export function inspectDatabase(path) {
  const db = new DatabaseSync(path, { readOnly: true, defensive: true });
  try {
    db.exec("PRAGMA trusted_schema=OFF");
    const checks = db.prepare("PRAGMA integrity_check").all();
    if (
      checks.length !== 1 ||
      Object.values(checks[0])[0] !== "ok" ||
      db.prepare("PRAGMA foreign_key_check").all().length
    )
      throw new Error("Restored database failed its integrity or foreign-key checks.");
    const schema = db
      .prepare(
        "SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all();
    if (
      schema.length !== TABLES.length ||
      TABLES.some((name) => !schema.some((row) => row.name === name))
    )
      throw new Error("Unexpected backup database schema.");
    return {
      integrity: "ok",
      schemaDigest: digest(JSON.stringify(schema)),
      counts: Object.fromEntries(
        TABLES.map((name) => [name, db.prepare(`SELECT count(*) AS n FROM ${name}`).get().n]),
      ),
    };
  } finally {
    db.close();
  }
}
async function temporary(directory, task) {
  const parent = resolve(directory);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const path = await mkdtemp(join(parent, ".seam-backup-"));
  await chmod(path, 0o700);
  if (dirname(resolve(path)) !== parent || !basename(path).startsWith(".seam-backup-"))
    throw new Error("Refusing unsafe backup cleanup.");
  try {
    return await task(path);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}
/** Restores into a NEW file only. Never replaces a running or existing database. */
export async function restoreBackup(encrypted, key, target, directory = tmpdir()) {
  const decoded = decryptBackup(encrypted, key);
  return temporary(directory, async (temp) => {
    const candidate = join(temp, "restored.sqlite");
    await writeFile(candidate, decoded.database, { flag: "wx", mode: 0o600 });
    const summary = inspectDatabase(candidate);
    if (target) await copyFile(candidate, resolve(target), constants.COPYFILE_EXCL);
    return { ...summary, createdAt: decoded.createdAt, sha256: decoded.sha256 };
  });
}
export function createBackupManager({
  db,
  storage,
  key,
  directory = tmpdir(),
  intervalSeconds = 21600,
  keep = 28,
  log = () => {},
}) {
  parseKey(key);
  if (
    !Number.isInteger(intervalSeconds) ||
    intervalSeconds < 300 ||
    intervalSeconds > 86400 ||
    !Number.isInteger(keep) ||
    keep < 2 ||
    keep > 100
  )
    throw new Error("Invalid backup schedule or retention.");
  let pending, timer;
  let state = { enabled: true, status: "pending", intervalSeconds, retainedBackups: keep };
  async function run() {
    if (pending) return pending;
    pending = temporary(directory, async (temp) => {
      const snapshot = join(temp, "snapshot.sqlite");
      await backup(db, snapshot, { rate: 64 });
      if ((await stat(snapshot)).size > 90 * 1024 * 1024)
        throw new Error("Database exceeds the backup size budget.");
      const summary = inspectDatabase(snapshot),
        encrypted = encryptBackup(await readFile(snapshot), key);
      const object = `seam-control-plane/v1/${new Date().toISOString().replace(/:/g, "-")}-${randomUUID()}.seamenc`;
      await storage.put(object, encrypted);
      const downloaded = await storage.get(object);
      if (digest(encrypted) !== digest(downloaded))
        throw new Error("Remote backup read-back checksum failed.");
      const restored = await restoreBackup(downloaded, key, undefined, temp);
      if (
        JSON.stringify(summary) !==
        JSON.stringify({
          integrity: restored.integrity,
          schemaDigest: restored.schemaDigest,
          counts: restored.counts,
        })
      )
        throw new Error("Remote backup restore check differs from the snapshot.");
      const objects = (await storage.list())
        .filter((item) => /^seam-control-plane\/v1\/[\dTZ.-]+-[a-f\d-]+\.seamenc$/.test(item))
        .sort()
        .reverse();
      for (const expired of objects.slice(keep)) await storage.remove(expired);
      state = {
        ...state,
        status: "healthy",
        lastSuccessAt: new Date().toISOString(),
        object,
        bytes: encrypted.length,
        restoreCheck: restored,
        nextRunAt: new Date(Date.now() + intervalSeconds * 1000).toISOString(),
      };
      log({ event: "backup_completed", bytes: encrypted.length });
      return state;
    })
      .catch(() => {
        state = {
          ...state,
          status: "failed",
          lastFailureAt: new Date().toISOString(),
          message: "Backup or isolated restore check failed. Inspect the operator tools.",
        };
        log({ event: "backup_failed" });
        throw new Error(state.message);
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  }
  return {
    run,
    status: () => ({ ...state }),
    start() {
      if (!timer) {
        timer = setInterval(() => void run().catch(() => {}), intervalSeconds * 1000);
        timer.unref();
        void run().catch(() => {});
      }
    },
    async close() {
      clearInterval(timer);
      await pending?.catch(() => {});
    },
  };
}
