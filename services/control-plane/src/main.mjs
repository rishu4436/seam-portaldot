import { mkdirSync, chownSync } from "node:fs";
import { resolve } from "node:path";
import { createControlPlane } from "./server.mjs";
import { createLiveServices } from "./live.mjs";

const dataDirectory = resolve(process.env.SEAM_DATA_DIR ?? "./seam-data");
mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
// Railway mounts its volume as root. Drop privileges before opening data or serving requests.
if (process.platform !== "win32" && process.getuid?.() === 0) {
  chownSync(dataDirectory, 1000, 1000);
  process.setgid(1000);
  process.setuid(1000);
}
const app = createControlPlane({
  database: resolve(dataDirectory, "control-plane.sqlite"),
  bootstrapToken: process.env.SEAM_BOOTSTRAP_TOKEN,
  origins: (process.env.SEAM_ALLOWED_ORIGINS ?? "https://seam-portaldot.vercel.app")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  ...createLiveServices(),
  log: (event) => console.log(JSON.stringify(event)),
});
const port = Number(process.env.PORT ?? 8080);
app.server.listen(port, "0.0.0.0", () => console.log(JSON.stringify({ event: "ready", port })));
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  app
    .close()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
  setTimeout(() => process.exit(1), 10000).unref();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
