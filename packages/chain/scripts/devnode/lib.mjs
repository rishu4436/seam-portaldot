// Shared helpers for the local dev-node scripts. LOCAL DEV CHAIN ONLY: //Alice is a public dev seed.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { u8aToHex, hexToU8a } from "@polkadot/util";
import {
  discover,
  readSigningCheckpoint,
  signingRequestsForCalls,
  assembleSignedExtrinsic,
  submitAndWatch,
  encodeRuntime,
  PORTALDOT_MAINNET_GENESIS,
  extrinsicHash,
} from "../../dist/index.js";

export const ENDPOINT = process.env.SEAM_DEVNODE_URL ?? "ws://127.0.0.1:9944";
export const EVIDENCE = process.env.SEAM_EVIDENCE_DIR ?? "/workspace/seam-evidence/devnode";
/** Copy inside the repo (evidence/devnode at the monorepo root), so the hashes are reviewable with the code. */
export const REPO_EVIDENCE =
  process.env.SEAM_REPO_EVIDENCE_DIR ??
  fileURLToPath(new URL("../../../../evidence/devnode", import.meta.url));
export const TYPES_BUNDLE = readFileSync(
  fileURLToPath(new URL("../../fixtures/devnode-types.json", import.meta.url)),
  "utf8",
);
/** substrate-contracts-node --dev reports no system_properties. UNIT = 1_000 * MILLIUNIT = 10^12 base units
 *  (runtime/src/lib.rs v0.42.0: MILLIUNIT = 1_000_000_000), so 12 decimals. Declared, not read from the node. */
export const DECLARED_TOKEN = { tokenSymbol: "UNIT", tokenDecimals: 12 };
export const ASSET_ID = 1;
export const STATE_FILE = `${EVIDENCE}/state.json`;

if (!/^ws:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(ENDPOINT)) {
  throw new Error(`refusing: dev-node scripts only talk to a local node, got ${ENDPOINT}`);
}

/**
 * Turns a recorded rollback run (run-rollback.mjs / seam-run.mjs evidence) into the compiler's AtomicRollbackProof.
 * Throws unless that run really showed the rollback; the compiler then checks it against the facts again.
 */
export function rollbackProofFromEvidence(facts, ev) {
  if (ev?.kind !== "batch_all-rollback" || ev.batchAllRollback !== "verified")
    throw new Error("rollback evidence does not show a verified rollback");
  const d = ev.directSubmit ?? {};
  const txHash = d.txHash ?? ev.directTxHash;
  const blockHash = d.block?.hash;
  if (!txHash && !blockHash) throw new Error("rollback evidence has no tx or block hash");
  const bal = (s) => s?.asset ?? s?.balances ?? s;
  return {
    genesisHash: facts.fingerprint.genesisHash,
    metadataHash: facts.fingerprint.metadataHash,
    specVersion: facts.fingerprint.specVersion,
    fingerprintDigest: facts.fingerprintDigest,
    ...(txHash ? { txHash } : {}),
    ...(blockHash ? { blockHash } : {}),
    preState: bal(ev.state?.before),
    postState: bal(ev.state?.after),
    composition: [...new Set(ev.plan.steps.map((s) => s.kind))],
  };
}

export async function devFacts(batchAllRollback, batchAllRollbackProof) {
  const facts = await discover(ENDPOINT, {
    typesBundle: TYPES_BUNDLE,
    declaredToken: DECLARED_TOKEN,
    ...(batchAllRollback ? { batchAllRollback } : {}),
    ...(batchAllRollbackProof ? { batchAllRollbackProof } : {}),
  });
  if (facts.fingerprint.genesisHash === PORTALDOT_MAINNET_GENESIS)
    throw new Error("refusing: this is Portaldot mainnet");
  if (facts.fingerprint.specName !== "substrate-contracts-node")
    throw new Error(`not the dev node: ${facts.fingerprint.specName}`);
  return facts;
}

export async function devKeys() {
  await cryptoWaitReady();
  const keyring = new Keyring({ type: "sr25519", ss58Format: 42 });
  return {
    alice: keyring.addFromUri("//Alice"),
    bob: keyring.addFromUri("//Bob"),
    charlie: keyring.addFromUri("//Charlie"),
  };
}

/** Encodes a call by pallet/method name on the facts' pinned registry. Setup only; SEAM plans come from compile(). */
export function encodeCall(facts, pallet, method, args) {
  const rt = encodeRuntime(facts);
  const call = rt.registry.createType("Call", { callIndex: findIndex(rt, pallet, method), args });
  return call.toHex();
}
function findIndex(rt, pallet, method) {
  const p = rt.metadata.asLatest.pallets.find((x) => x.name.toString() === pallet);
  if (!p || p.calls.isNone) throw new Error(`no pallet ${pallet}`);
  const variants = rt.registry.lookup.getSiType(p.calls.unwrap().type).def.asVariant.variants;
  const v = variants.find((x) => x.name.toString() === method);
  if (!v) throw new Error(`no call ${pallet}.${method}`);
  return new Uint8Array([p.index.toNumber(), v.index.toNumber()]);
}

/** Signs one call with a dev key through SEAM's own signing path and submits it. */
export async function sendSigned(facts, pair, callHex, { mortalityBlocks = 64, nonce } = {}) {
  const checkpoint = await readSigningCheckpoint(ENDPOINT);
  const n = nonce ?? (await nextNonce(pair.address));
  const [req] = signingRequestsForCalls([callHex], facts, {
    signer: pair.address,
    nonce: n,
    mortalityBlocks,
    checkpoint,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  });
  const sig = u8aToHex(pair.sign(hexToU8a(req.signBytesHex), { withType: true }));
  const xt = assembleSignedExtrinsic(req.payload, sig, facts);
  const res = await submitAndWatch(ENDPOINT, xt, undefined, { facts, timeoutMs: 60_000 });
  return { ...res, extrinsic: xt, txHashLocal: extrinsicHash(xt) };
}

export async function nextNonce(address) {
  const { withClient } = await import("../../dist/index.js");
  return withClient(ENDPOINT, (c) => c.send("system_accountNextIndex", [address]));
}

export function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}
/** Keys that must never appear in evidence: signatures, signed extrinsics (they embed the signature), key material. */
const SECRET_KEYS =
  /^(signature|signatures|signedTx|signedTxs|signedExtrinsic|extrinsic|seed|secret|secretKey|privateKey|mnemonic|suri|uri|pair|keypair)$/i;
/** Dev-key derivation paths / mnemonics: refuse to write them even inside strings. */
const SECRET_TEXT =
  /\/\/(Alice|Bob|Charlie|Dave|Eve|Ferdie)\b|bottom drive obey lake curtain smoke basket hold race lonely fit walk/;

/** Throws if value contains a signature, signed extrinsic, seed or key. Returns the JSON text. */
export function evidenceJson(value) {
  const text =
    JSON.stringify(
      value,
      (k, v) => {
        if (k && SECRET_KEYS.test(k))
          throw new Error(`refusing to write evidence: field "${k}" could hold a signature or key`);
        return typeof v === "bigint" ? v.toString() : v;
      },
      1,
    ) + "\n";
  if (SECRET_TEXT.test(text))
    throw new Error("refusing to write evidence: it contains a dev seed / derivation path");
  return text;
}

/** Writes one evidence file to /workspace/seam-evidence/devnode/<rel> and to <repo>/evidence/devnode/<rel>. */
export function saveEvidence(rel, value) {
  const text = evidenceJson(value);
  for (const dir of [EVIDENCE, REPO_EVIDENCE]) {
    const path = `${dir}/${rel}`;
    mkdirSync(path.replace(/\/[^/]+$/, ""), { recursive: true });
    writeFileSync(path, text);
  }
  return `${EVIDENCE}/${rel}`;
}

export function saveJson(path, value) {
  mkdirSync(path.replace(/\/[^/]+$/, ""), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 1) + "\n",
  );
}
export const brief = (r) => ({
  txHash: r.txHash,
  status: r.status,
  history: r.history,
  error: r.error,
  block: r.inclusion ? { number: r.inclusion.number, hash: r.inclusion.hash } : undefined,
  extrinsicIndex: r.inclusion?.extrinsicIndex,
  success: r.inclusion?.success,
  dispatchError: r.inclusion?.dispatchError,
  events: r.inclusion?.events.map((e) => `${e.pallet}.${e.name}(${e.args.join(", ")})`),
});
