// Deployment smoke check. Existing workspace credentials stay in the ignored local access file.
import { readFileSync, writeFileSync } from "node:fs";
const access = JSON.parse(readFileSync("secrets/control-plane-team-access.json", "utf8"));
if (access.url !== "https://control-plane-production-3a6b.up.railway.app")
  throw new Error("Unexpected backend destination");
async function request(path, method = "GET", authenticated = true) {
  const options = {
    method,
    redirect: "error",
    headers: {
      origin: "https://seam-portaldot.vercel.app",
      ...(authenticated ? { authorization: `Bearer ${access.accessKey}` } : {}),
    },
    signal: AbortSignal.timeout(45000),
  };
  let response;
  try {
    response = await fetch(new URL(path, access.url), options);
  } catch (error) {
    if (method !== "GET") throw error;
    response = await fetch(new URL(path, access.url), {
      ...options,
      signal: AbortSignal.timeout(45000),
    });
  }
  if (!response.ok) throw new Error(`Backend smoke check failed: HTTP ${response.status}`);
  return response.json();
}
const prefix = `/v1/workspaces/${access.workspaceId}`;
const [health, session, evidence, monitors, keys] = await Promise.all([
  request("/healthz", "GET", false),
  request("/v1/session"),
  request(`${prefix}/evidence`),
  request(`${prefix}/monitors`),
  request(`${prefix}/keys`),
]);
if (!session.keyId || !keys.keys.some((key) => key.id === session.keyId && !key.revoked_at))
  throw new Error("Current session key was not identified");
const historical = evidence.evidence.find((item) => item.name.startsWith("Historical V3"));
if (!historical || historical.claimed_result !== "verified" || !monitors.monitors.length)
  throw new Error("Persistent workspace data or receipt claim is missing");
const verification = await request(`${prefix}/evidence/${historical.id}/verify`, "POST");
const refreshed = await request(`${prefix}/evidence`);
const row = refreshed.evidence.find((item) => item.id === historical.id);
if (!verification.checkedAt || !row.verified_at || row.verification.status !== verification.status)
  throw new Error("Verification freshness or persistence failed");
const report = {
  checkedAt: new Date().toISOString(),
  backendDeploymentId: "a146ffb1-bf0b-4c41-bbfa-897ae63ea660",
  health,
  existingSessionKeyIdentified: true,
  evidenceRecords: refreshed.evidence.length,
  monitors: monitors.monitors.length,
  historicalReceiptClaim: row.claimed_result,
  independentStatus: verification.status,
  fullLiveVerificationPassed: verification.status === "chain_verified",
  notes: verification.notes ?? [],
  lastCheckedAt: verification.checkedAt,
  persistedVerificationAt: row.verified_at,
};
writeFileSync("docs/product-audit-live-2026-11-03.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
if (!report.fullLiveVerificationPassed) process.exitCode = 1;
