#!/usr/bin/env node
// Runs every command in docs/quickstart.md's ```bash blocks and checks its exit code.
// Lines starting with "#" are sample output. "# exit N" sets the expected exit code (default 0).
// "# setup" lines are skipped. "# network" lines run only with --network or SEAM_QUICKSTART_NETWORK=1.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const doc = process.argv.find((a) => a.endsWith(".md")) ?? join(root, "docs/quickstart.md");
const network = process.argv.includes("--network") || process.env.SEAM_QUICKSTART_NETWORK === "1";

export function extractCommands(md) {
  const cmds = [];
  let inBash = false;
  md.split("\n").forEach((line, i) => {
    const fence = /^```(\S*)/.exec(line);
    if (fence) {
      inBash = !inBash && fence[1] === "bash";
      return;
    }
    if (!inBash) return;
    const t = line.trim();
    if (!t || t.startsWith("#")) return;
    const tags = [...t.matchAll(/#\s*(setup|network|exit\s+(\d+))\s*(?=#|$)/g)];
    const cmd = t.replace(
      /\s+#\s*(setup|network|exit\s+\d+)(\s+#\s*(setup|network|exit\s+\d+))*\s*$/,
      "",
    );
    const exit = tags.find((m) => m[2] !== undefined);
    cmds.push({
      line: i + 1,
      cmd,
      setup: tags.some((m) => m[1] === "setup"),
      network: tags.some((m) => m[1] === "network"),
      expect: exit ? Number(exit[2]) : 0,
    });
  });
  if (inBash) throw new Error(`${doc}: unclosed bash block`);
  return cmds;
}

const cmds = extractCommands(readFileSync(doc, "utf8"));
let ran = 0,
  skipped = 0;
const failures = [];
for (const c of cmds) {
  if (c.setup || (c.network && !network)) {
    skipped++;
    console.log(`skip  L${c.line} [${c.setup ? "setup" : "network"}] ${c.cmd}`);
    continue;
  }
  const r = spawnSync("bash", ["-c", c.cmd], { cwd: root, encoding: "utf8", timeout: 180_000 });
  ran++;
  const ok = r.status === c.expect;
  console.log(`${ok ? "ok  " : "FAIL"}  L${c.line} exit ${r.status} (want ${c.expect}) ${c.cmd}`);
  if (!ok) failures.push({ ...c, status: r.status, out: `${r.stdout}${r.stderr}`.slice(-1500) });
}
for (const f of failures) console.error(`\n--- L${f.line}: ${f.cmd}\n${f.out}`);
console.log(
  `\n${ran} ran, ${skipped} skipped, ${failures.length} failed${network ? "" : " (network commands skipped; use --network)"}`,
);
if (!cmds.length) {
  console.error("no commands found");
  process.exit(1);
}
process.exit(failures.length ? 1 : 0);
