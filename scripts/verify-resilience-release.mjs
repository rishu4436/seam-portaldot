// Private operator inputs are read from ignored local files. No credentials or database contents are logged.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { backupStorage } from "../services/control-plane/src/backup-storage.mjs";
import { restoreBackup } from "../services/control-plane/src/backups.mjs";
import { createControlPlane } from "../services/control-plane/src/server.mjs";

const access = JSON.parse(readFileSync("secrets/control-plane-team-access.json", "utf8"));
const operator = readFileSync("secrets/control-plane-admin-key.txt", "utf8").trim();
const encryptionKey = readFileSync("secrets/control-plane-backup-key.txt", "utf8").trim();
const credentials = JSON.parse(readFileSync("secrets/control-plane-backup-storage.json", "utf8"));
if (access.url !== "https://control-plane-production-3a6b.up.railway.app")
  throw new Error("Unexpected backend origin.");
const storage = backupStorage({
  SEAM_BACKUP_S3_ENDPOINT: credentials.endpoint,
  SEAM_BACKUP_S3_BUCKET: credentials.bucketName,
  SEAM_BACKUP_S3_ACCESS_KEY_ID: credentials.accessKeyId,
  SEAM_BACKUP_S3_SECRET_ACCESS_KEY: credentials.secretAccessKey,
  SEAM_BACKUP_S3_REGION: credentials.region,
  SEAM_BACKUP_S3_PATH_STYLE: String(credentials.urlStyle === "path"),
});
async function get(origin, path, key) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(new URL(path, origin), {
        redirect: "error",
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(20000),
      });
      return { status: response.status, body: await response.json() };
    } catch (error) {
      last = error;
    }
  }
  throw last;
}
let state;
for (let attempt = 0; attempt < 12; attempt++) {
  const response = await get(access.url, "/v1/operations/backups", operator);
  if (response.status === 200 && response.body.status === "healthy") {
    state = response.body;
    break;
  }
  if (response.body.status === "failed")
    throw new Error("The deployed backup or restore check failed.");
  await new Promise((done) => setTimeout(done, 5000));
}
if (!state) throw new Error("The deployed backup is not healthy yet.");
const denied = await get(access.url, "/v1/operations/backups", access.accessKey);
if (denied.status !== 403) throw new Error("Workspace credentials can access operator backups.");
const encrypted = await storage.get(state.object);
const stamp = randomUUID(),
  target = resolve(`secrets/restore-drill-${stamp}.sqlite`);
writeFileSync(`secrets/backup-drill-${stamp}.seamenc`, encrypted, { mode: 0o600, flag: "wx" });
const restored = await restoreBackup(encrypted, encryptionKey, target);
const app = createControlPlane({ database: target, bootstrapToken: operator, worker: false });
await new Promise((done) => app.server.listen(0, "127.0.0.1", done));
let proof;
try {
  const origin = `http://127.0.0.1:${app.server.address().port}`,
    prefix = `/v1/workspaces/${access.workspaceId}`;
  const session = await get(origin, "/v1/session", access.accessKey);
  const evidence = await get(origin, `${prefix}/evidence`, access.accessKey);
  const monitors = await get(origin, `${prefix}/monitors`, access.accessKey);
  const keys = await get(origin, `${prefix}/keys`, access.accessKey);
  if (
    session.status !== 200 ||
    !evidence.body.evidence.length ||
    !monitors.body.monitors.length ||
    !keys.body.keys.some((key) => key.revoked_at)
  )
    throw new Error("Restored API is missing credentials, evidence, monitors or revocation state.");
  proof = {
    authentication: true,
    evidenceRecords: evidence.body.evidence.length,
    monitors: monitors.body.monitors.length,
    revokedKeysPreserved: true,
  };
} finally {
  await app.close();
}
const report = {
  checkedAt: new Date().toISOString(),
  backendDeploymentId: process.env.SEAM_BACKEND_DEPLOYMENT_ID,
  backup: {
    encrypted: true,
    separatePrivateBucket: true,
    intervalSeconds: state.intervalSeconds,
    retainedBackups: state.retainedBackups,
    bytes: state.bytes,
    lastSuccessAt: state.lastSuccessAt,
  },
  isolatedRestore: restored,
  restoredApi: proof,
  workspaceBackupAccessDenied: true,
  liveDatabaseReplaced: false,
};
writeFileSync("docs/resilience-live-2026-11-04.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
