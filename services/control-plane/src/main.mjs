import { mkdirSync, chownSync } from "node:fs";
import { resolve } from "node:path";
import { createControlPlane } from "./server.mjs";
import { createLiveServices } from "./live.mjs";
import { createBackupManager } from "./backups.mjs";
import { backupStorage } from "./backup-storage.mjs";

const dataDirectory = resolve(process.env.SEAM_DATA_DIR ?? "./seam-data");
mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
// Railway mounts its volume as root. Drop privileges before opening data or serving requests.
if (process.platform !== "win32" && process.getuid?.() === 0) {
  chownSync(dataDirectory, 1000, 1000);
  process.setgid(1000);
  process.setuid(1000);
}
let backups;
const app = createControlPlane({
  backups: () => backups,
  database: resolve(dataDirectory, "control-plane.sqlite"),
  bootstrapToken: process.env.SEAM_BOOTSTRAP_TOKEN,
  origins: (process.env.SEAM_ALLOWED_ORIGINS ?? "https://seam-portaldot.vercel.app")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  ...createLiveServices(
    undefined,
    process.env.SEAM_RPC_ENDPOINTS?.split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ),
  log: (event) => console.log(JSON.stringify(event)),
});
if (process.env.SEAM_BACKUP_ENCRYPTION_KEY) {
  backups = createBackupManager({
    db: app.store.db,
    storage: backupStorage(),
    key: process.env.SEAM_BACKUP_ENCRYPTION_KEY,
    directory: dataDirectory,
    intervalSeconds: Number(process.env.SEAM_BACKUP_INTERVAL_SECONDS ?? 21600),
    keep: Number(process.env.SEAM_BACKUP_KEEP ?? 28),
    log: (event) => console.log(JSON.stringify(event)),
  });
  backups.start();
}
const port = Number(process.env.PORT ?? 8080);
const logMemory = () =>
  console.log(
    JSON.stringify({
      event: "memory",
      uptimeSeconds: Math.floor(process.uptime()),
      ...process.memoryUsage(),
    }),
  );
const memoryTimer = setInterval(logMemory, 300000);
memoryTimer.unref();
app.server.listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({ event: "ready", port }));
  logMemory();
});
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  clearInterval(memoryTimer);
  Promise.resolve(backups?.close())
    .then(() => app.close())
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
  setTimeout(() => process.exit(1), 10000).unref();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
