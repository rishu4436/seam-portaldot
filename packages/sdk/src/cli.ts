#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile, SeamCompileError, type RuntimeFacts } from "@seam/compiler";
import { evaluatePolicy, parsePolicy } from "@seam/policy";
import { parseManifest } from "./manifest.js";
import { receiptIntegrity, receiptShapeProblem, type Receipt } from "./receipt.js";
import { classifyError, classifyReceipt, EXIT, SeamCode } from "./codes.js";
import { diffRuntimes, explainDrift } from "./drift.js";
import { createChainReader, verifyReceiptLive } from "./verify-live.js";
import { explainManifestIssues, explainPlan, explainPolicy, explainReceipt } from "./explain.js";
import { factsFromSnapshot } from "./offline.js";
import { parseAbiFlags, parseRuntimeFlag, parseTokenFlag, pickReceipt } from "./cliargs.js";

const HELP = `seam <command> [file] [options]

  seam digest  <manifest.json>                    Check a Manifest and print its digest
  seam compile <manifest.json> [--json]           Compile against the runtime snapshot and explain the plan
  seam check   <manifest.json> --policy <p.json>  Compile, then run the policy check
  seam verify  <receipt.json>                     Offline: integrity only (not edited since written). NOT on-chain proof
  seam verify  --endpoint <ws> --plan <plan.json> <receipt.json>
                                                  Live: re-read the chain. chain_verified needs the plan; without --plan the result is unknown.
                                                  A step that is not_verified (in the receipt or on re-check) is failed, not unknown
  seam verify  --endpoint <ws> --plan <plan.json> --runtime <run.json|fingerprint.json> <receipt.json>
                                                  Also pin the runtime the plan ran on (a run record's "fingerprint", or a bare
                                                  RuntimeFingerprint). Its digest must equal the receipt's fingerprintDigest, and
                                                  genesis, spec, tx version and ss58 must match the node (only the metadata hash may
                                                  differ). Turns on the V3 nfts.mint / revive.call checks
  seam explain <plan|policy-result|receipt.json>  Explain any SEAM result in plain English
  seam drift   <snapA> <snapB> [--plan <plan.json>]  Compare two saved runtimes: changed fingerprint fields and calls (offline; exit 10 on drift)
  seam snapshot <ws-endpoint> <out-dir> [--name n]  Save a node's runtime (read-only) for offline use

Which runtime to compile against (pick one; default is the bundled Portaldot mainnet snapshot, spec 1002):
  --snapshot <dir|file>  A saved snapshot: a folder with one <name>-snapshot.json and <name>-metadata.hex, or the snapshot file
  --name <name>          Which snapshot, when the folder holds several
  --endpoint <ws-url>    Read the live runtime from a node instead (read-only)

  --token SYM:DEC        Token symbol and decimals, for a chain whose system_properties doesn't report them (e.g. --token UNIT:12).
                         The node's own value wins; if it differs, SEAM stops instead of guessing.

ink! contract calls written with "abiRef":
  --abi NAME=<file>      Load an ink! metadata.json under NAME (repeatable). A contracts.call with "abiRef": "NAME" uses it.

  --json            Print raw JSON instead of the explanation`;

const argv = process.argv.slice(2);
const flag = (n: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const json = argv.includes("--json");
const [cmd, file] = argv;
const read = (f: string) => JSON.parse(readFileSync(f, "utf8"));
const out = (text: string, data: unknown, code?: SeamCode) =>
  console.log(
    json
      ? JSON.stringify(
          code && data && typeof data === "object" && !Array.isArray(data)
            ? { code, ...data }
            : code
              ? { code, details: data }
              : data,
          null,
          2,
        )
      : text,
  );
function bail(code: SeamCode): never {
  return process.exit(EXIT[code]);
}
const snapshotDir = () =>
  flag("--snapshot") ?? join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

function loadManifest() {
  if (!file) throw new Error("missing manifest file");
  const r = parseManifest(readFileSync(file, "utf8"));
  if (!r.ok) {
    out(explainManifestIssues(r.issues), r, SeamCode.ManifestInvalid);
    bail(SeamCode.ManifestInvalid);
  }
  return r;
}

async function compileOrExit(m: ReturnType<typeof loadManifest> & { ok: true }) {
  const facts = await loadFacts();
  try {
    return { facts, plan: compile(m.manifest, facts, { abis: loadAbis() }) };
  } catch (e) {
    if (e instanceof SeamCompileError) {
      out(
        [
          "The Manifest could not be compiled:",
          ...e.issues.map((i) => `- ${i.path ?? "$"}: ${i.message}`),
        ].join("\n"),
        e.issues,
        SeamCode.CompileFailed,
      );
      bail(SeamCode.CompileFailed);
    }
    throw e;
  }
}
/** Arguments that are neither flags nor flag values: [command, file...]. */
function positional(valueFlags: string[]): string[] {
  const o: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (valueFlags.includes(a)) i++;
    else if (!a.startsWith("--")) o.push(a);
  }
  return o;
}
const flagValues = (n: string) => argv.flatMap((a, i) => (a === n ? [argv[i + 1]] : []));
const tokenFlag = () =>
  parseTokenFlag(argv.includes("--token") ? (argv[argv.indexOf("--token") + 1] ?? "") : undefined);
const loadAbis = () =>
  parseAbiFlags(
    flagValues("--abi").map((v) => v ?? ""),
    (f) => JSON.parse(readFileSync(f, "utf8")),
  );
let cached: RuntimeFacts | undefined;
async function loadFacts(): Promise<RuntimeFacts> {
  if (cached) return cached;
  const endpoint = flag("--endpoint");
  if (endpoint) {
    const chain: any = await import("@seam/chain").catch(() => {
      throw new Error("--endpoint needs the @seam/chain package installed");
    });
    const declaredToken = tokenFlag();
    cached = await chain.discover(endpoint, declaredToken ? { declaredToken } : {});
  } else {
    cached = factsFromSnapshot(snapshotDir(), { name: flag("--name"), declaredToken: tokenFlag() });
  }
  return cached!;
}
function describeRuntime(f: RuntimeFacts): string {
  const fp = f.fingerprint;
  return `Runtime: ${fp.specName} spec ${fp.specVersion} (${fp.tokenSymbol}), ${flag("--endpoint") ? `live from ${flag("--endpoint")}` : `snapshot${f.blockNumber !== undefined ? ` at block ${f.blockNumber}` : ""}`}.`;
}

async function main() {
  switch (cmd) {
    case "digest": {
      const m = loadManifest();
      if (m.ok) out(`Manifest is valid. Digest: ${m.digest}`, { digest: m.digest });
      break;
    }
    case "compile": {
      const m = loadManifest();
      if (!m.ok) break;
      const { plan, facts } = await compileOrExit(m);
      out(
        `${describeRuntime(facts)}\n${explainPlan(plan)}\nPlan digest: ${plan.planDigest}`,
        plan,
        plan.mode === "unavailable" ? SeamCode.PlanUnavailable : undefined,
      );
      if (plan.mode === "unavailable") bail(SeamCode.PlanUnavailable);
      break;
    }
    case "check": {
      const m = loadManifest();
      if (!m.ok) break;
      const p = flag("--policy");
      if (!p) throw new Error("check needs --policy <policy.json>");
      const parsed = parsePolicy(readFileSync(p, "utf8"));
      if (!parsed.ok) {
        out(
          [
            "The policy file has problems, so nothing was checked:",
            ...parsed.issues.map((i) => `- ${i.path}: ${i.message}`),
          ].join("\n"),
          parsed,
          SeamCode.PolicyFileInvalid,
        );
        bail(SeamCode.PolicyFileInvalid);
      }
      const warn = parsed.warnings.length
        ? `\n\nPolicy warnings:\n${parsed.warnings.map((w) => `- ${w.path}: ${w.message}`).join("\n")}`
        : "";
      const { plan, facts: f } = await compileOrExit(m);
      const result = evaluatePolicy({
        policy: parsed.policy,
        plan,
        facts: f,
        manifest: m.manifest,
      });
      // Offline there is no preflight (fees, weight, dry runs need a node). Report everything else, and say so plainly.
      const rest = result.rules.filter((r) => r.rule !== "preflight");
      const offlineOk = rest.every((r) => r.outcome === "pass");
      const text =
        offlineOk && !result.allowed
          ? `Offline check passed: all ${rest.length} rules that don't need a node passed. Fees, weight and dry runs are checked against a live node before approval.`
          : explainPolicy({ ...result, rules: rest });
      out(
        `${describeRuntime(f)}\n${explainPlan(plan)}\n\n${text}${warn}`,
        { plan, policyResult: result, warnings: parsed.warnings, offline: true },
        offlineOk ? undefined : SeamCode.PolicyBlocked,
      );
      if (!offlineOk) bail(SeamCode.PolicyBlocked);
      break;
    }
    case "verify": {
      const rf = positional([
        "--endpoint",
        "--plan",
        "--snapshot",
        "--name",
        "--token",
        "--abi",
        "--runtime",
      ])[1];
      if (!rf) throw new Error("missing receipt file");
      const picked = pickReceipt(read(rf), rf);
      const r = picked.receipt as Receipt;
      const source = picked.field
        ? `- note: ${rf} is a run record; checking its "${picked.field}".`
        : "";
      if (source && !json) console.log(source);
      const integrity = receiptIntegrity(r);
      if (integrity.status === "failed") {
        out(
          receiptShapeProblem(r)
            ? `WARNING: ${rf}${picked.field ? ` (${picked.field})` : ""}: ${integrity.note}`
            : `WARNING: ${integrity.note}\n${explainReceipt(r)}`,
          { status: "failed", integrity, receiptSource: picked.field ?? null, receipt: r },
          SeamCode.IntegrityFailed,
        );
        bail(SeamCode.IntegrityFailed);
      }
      const oc = classifyReceipt(r);
      const endpoint = flag("--endpoint");
      if (!endpoint) {
        out(`Receipt status: integrity_checked (${integrity.note})\n${explainReceipt(r)}`, {
          status: "integrity_checked",
          note: integrity.note,
          outcome: oc,
          receiptSource: picked.field ?? null,
          receipt: r,
        });
        // Integrity is fine, but a receipt whose run was partial/uncertain/not verified must not look like success.
        process.exit(oc.exitCode);
      }
      const planFile = flag("--plan");
      // A run record carries its own plan; it is used only when --plan is not given, and the plan digest is still checked.
      const plan = planFile ? read(planFile) : picked.plan;
      if (!planFile && picked.plan && !json)
        console.log(`- note: using the plan in ${rf} ("plan").`);
      // Parsed before any network call, so a bad --runtime file fails fast with a usage error.
      const runtime = parseRuntimeFlag(
        argv.includes("--runtime") ? (flag("--runtime") ?? "") : undefined,
        read,
      );
      const facts = await loadFacts();
      const reader = await createChainReader(endpoint, facts);
      const live = await verifyReceiptLive(r, reader, {
        plan,
        runtime,
      });
      const lines = [
        `Receipt status: ${live.status} (live, read from ${endpoint}).`,
        ...live.problems.map((x) => `- PROBLEM: ${x}`),
        ...live.notes.map((x) => `- note: ${x}`),
        live.status === "chain_verified"
          ? "The transactions, blocks, signer, call and events in this receipt match the chain. What they prove is what the result below says."
          : "",
        explainReceipt(r),
      ].filter(Boolean);
      const lc =
        live.status === "chain_verified"
          ? SeamCode.ChainVerified
          : live.status === "failed"
            ? SeamCode.ChainVerifyFailed
            : SeamCode.ChainVerifyUnknown;
      out(
        lines.join("\n"),
        { status: live.status, live, outcome: oc, receiptSource: picked.field ?? null, receipt: r },
        lc,
      );
      // Chain checks passed only says the receipt matches the chain; the run's own outcome still decides the exit code.
      process.exit(lc === SeamCode.ChainVerified ? oc.exitCode : EXIT[lc]);
    }
    case "explain": {
      if (!file) throw new Error("missing file");
      const d = read(file);
      if (d.receiptVersion) console.log(explainReceipt(d));
      else if (d.planVersion) console.log(explainPlan(d));
      else if (Array.isArray(d.rules)) console.log(explainPolicy(d));
      else throw new Error("not a plan, policy result or receipt");
      break;
    }
    case "drift": {
      const [, pa, pb] = positional(["--plan", "--name"]);
      if (!pa || !pb)
        throw new Error("usage: seam drift <snapshotA> <snapshotB> [--plan <plan.json>]");
      const planFile = flag("--plan");
      const report = diffRuntimes(
        factsFromSnapshot(pa, { name: flag("--name") }),
        factsFromSnapshot(pb, { name: flag("--name") }),
        { plan: planFile ? read(planFile) : undefined },
      );
      const code = report.drifted ? SeamCode.RuntimeDrift : SeamCode.Ok;
      out(explainDrift(report), report, code);
      if (report.drifted) bail(code);
      break;
    }
    case "snapshot": {
      const [, endpoint, outDir] = argv;
      if (!endpoint || !outDir)
        throw new Error("usage: seam snapshot <ws-endpoint> <out-dir> [--name n]");
      const chain: any = await import("@seam/chain").catch(() => {
        throw new Error("snapshot needs the @seam/chain package installed");
      });
      const files = await chain.snapshotFromNode(endpoint, outDir, { name: flag("--name") });
      out(`Saved the runtime of ${endpoint} (read-only). Use it with --snapshot ${outDir}`, files);
      break;
    }
    default:
      console.log(HELP);
      process.exit(cmd && cmd !== "help" && cmd !== "--help" ? EXIT[SeamCode.UsageError] : 0);
  }
}

main().catch((e) => {
  const code = classifyError(e);
  console.error(
    json
      ? JSON.stringify({ code, message: (e as Error).message })
      : `seam: ${(e as Error).message}`,
  );
  process.exit(EXIT[code]);
});
