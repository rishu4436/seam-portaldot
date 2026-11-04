import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const root = "packages/console/dist",
  base = "https://seam-portaldot.vercel.app/",
  files = [];
function walk(dir, prefix = "") {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = prefix + entry.name;
    if (entry.isDirectory()) walk(`${dir}/${entry.name}`, `${path}/`);
    else files.push(path);
  }
}
walk(root);
const hash = (value) => createHash("sha256").update(value).digest("hex");
async function get(path) {
  let error;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fetch(new URL(path, base), {
        cache: "no-store",
        headers: { "cache-control": "no-cache" },
        signal: AbortSignal.timeout(20000),
      });
    } catch (failure) {
      error = failure;
    }
  }
  throw error;
}
const rows = [];
let next = 0;
async function worker() {
  while (next < files.length) {
    const file = files[next++],
      local = readFileSync(`${root}/${file}`);
    try {
      const response = await get(file),
        remote = Buffer.from(await response.arrayBuffer());
      rows.push({
        file,
        status: response.status,
        bytes: local.length,
        sha256: hash(local),
        match: response.ok && hash(local) === hash(remote),
      });
    } catch (error) {
      rows.push({ file, match: false, error: error.message });
    }
  }
}
await Promise.all([worker(), worker(), worker(), worker()]);
const response = await get("console.html");
const report = {
  checkedAt: new Date().toISOString(),
  url: base,
  frontendDeploymentId: "dpl_GbGSSjS9B7iLj96AgpngDWdzqwua",
  frontendImmutableUrl: "https://seam-portaldot-bf1voq0yp-rishu4436s-projects.vercel.app",
  backendDeploymentId: "37a65b03-0e8f-4d4d-9e5f-4b2afb1258fe",
  files: rows.sort((a, b) => a.file.localeCompare(b.file)),
  failures: rows.filter((row) => !row.match),
  headers: Object.fromEntries(
    ["x-frame-options", "x-content-type-options", "referrer-policy", "permissions-policy"].map(
      (key) => [key, response.headers.get(key)],
    ),
  ),
};
writeFileSync("docs/feedback-build-2026-11-04.json", JSON.stringify(report, null, 2) + "\n");
console.log(
  JSON.stringify({ files: rows.length, failures: report.failures, headers: report.headers }),
);
if (report.failures.length) process.exitCode = 1;
