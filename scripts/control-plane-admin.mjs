// Operator-only setup/export. Credentials are read from ignored local files and never logged.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
const endpoint = new URL(
  process.env.SEAM_CONTROL_URL ?? "https://control-plane-production-3a6b.up.railway.app",
);
if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password)
  throw new Error("Use a trusted HTTPS backend origin.");
const keyFile = resolve(process.env.SEAM_ADMIN_KEY_FILE ?? "secrets/control-plane-admin-key.txt");
const accessFile = resolve(
  process.env.SEAM_TEAM_ACCESS_FILE ?? "secrets/control-plane-team-access.json",
);
async function request(path, method = "GET", body, key = readFileSync(keyFile, "utf8").trim()) {
  const response = await fetch(new URL(path, endpoint), {
    method,
    redirect: "error",
    headers: {
      authorization: `Bearer ${key}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(45000),
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(
      `Operation failed: HTTP ${response.status}, request ${value.requestId ?? "unknown"}`,
    );
  return value;
}
const action = process.argv[2];
if (action === "setup") {
  if (existsSync(accessFile))
    throw new Error(
      "A local team access file already exists. Reuse it instead of creating another workspace.",
    );
  const workspace = await request("/v1/workspaces", "POST", { name: "SEAM Team" });
  mkdirSync(dirname(accessFile), { recursive: true });
  writeFileSync(
    accessFile,
    JSON.stringify(
      { url: endpoint.origin, workspaceId: workspace.id, accessKey: workspace.accessKey },
      null,
      2,
    ) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  const monitor = await request(
    `/v1/workspaces/${workspace.id}/monitors`,
    "POST",
    { name: "Portaldot V3 runtime", intervalSeconds: 900 },
    workspace.accessKey,
  );
  console.log(
    JSON.stringify({
      workspaceId: workspace.id,
      monitorId: monitor.id,
      credentialsSavedTo: accessFile,
    }),
  );
} else if (action === "export") {
  const access = JSON.parse(readFileSync(accessFile, "utf8"));
  const value = await request(
    `/v1/workspaces/${access.workspaceId}/export`,
    "GET",
    undefined,
    access.accessKey,
  );
  const target = resolve(`secrets/workspace-export-${Date.now()}.json`);
  writeFileSync(target, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  console.log(`Workspace snapshot saved to ${target}`);
} else throw new Error("Usage: node scripts/control-plane-admin.mjs setup|export");
