// Shared pieces for scripts/testnet-run.mjs and scripts/external-signer/run.mjs: runtime report, signer loading,
// signing + submitting setup calls through SEAM's signing path, contract deployment, and the three flows with
// sanitized recordings. Works against any node (the dev-node scripts in devnode/ stay local-only).
// Nothing here stores a seed, key or signature: signers are closures, and every file goes through guardedJson().
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { Keyring } from "@polkadot/keyring";
import {
  cryptoWaitReady,
  mnemonicGenerate,
  encodeAddress,
  blake2AsHex,
} from "@polkadot/util-crypto";
import { u8aToHex, hexToU8a } from "@polkadot/util";
import {
  discover,
  listRpcMethods,
  refetchFingerprint,
  decodeRuntime,
  storageKey,
  withClient,
  readSigningCheckpoint,
  signingRequestsForCalls,
  assembleSignedExtrinsic,
  signBytesOf,
  submitAndWatch,
  extrinsicHash,
  createPortaldotAdapter,
  PORTALDOT_MAINNET_GENESIS,
  metadataVersionOf,
} from "../dist/index.js";
import {
  runFlow,
  devManifest,
  devPolicy,
  rollbackActions,
  settleEffect,
  ABIS,
} from "./devnode/flow.mjs";
import { encodeCall, brief, rollbackProofFromEvidence } from "./devnode/lib.mjs";

export const DEMO_BUNDLE = fileURLToPath(
  new URL("../../../contracts/seam-demo/artifacts/seam_demo.contract", import.meta.url),
);
const MAINNET_HOSTS = /(^|\.)mainnet\.portaldot\.io(:\d+)?(\/|$)/i;

/** Refuses Portaldot mainnet by URL (checked before connecting) and by genesis hash (checked after). */
export function assertNotMainnetUrl(url) {
  if (MAINNET_HOSTS.test(url.replace(/^wss?:\/\//, "")))
    throw new Error("refusing: that is the Portaldot mainnet endpoint");
}
export function assertNotMainnetFacts(facts) {
  if (facts.fingerprint.genesisHash === PORTALDOT_MAINNET_GENESIS)
    throw new Error("refusing: genesis hash is Portaldot mainnet");
}

/** Sanitizing JSON: the same field guard as the dev-node evidence, plus a check that no secret value leaked into the text. */
const SECRET_KEYS =
  /^(signature|signatures|signedTx|signedTxs|signedExtrinsic|extrinsic|seed|secret|secretKey|privateKey|mnemonic|suri|uri|pair|keypair|password)$/i;
export function makeGuard(secrets = []) {
  const vals = secrets.filter((s) => typeof s === "string" && s.length >= 4);
  return function guardedJson(value) {
    const text =
      JSON.stringify(
        value,
        (k, v) => {
          if (k && SECRET_KEYS.test(k))
            throw new Error(
              `refusing to write evidence: field "${k}" could hold a signature or key`,
            );
          return typeof v === "bigint" ? v.toString() : v;
        },
        1,
      ) + "\n";
    for (const s of vals)
      if (text.includes(s))
        throw new Error("refusing to write evidence: it contains the signer secret");
    if (/\/\/(Alice|Bob|Charlie|Dave|Eve|Ferdie)\b/.test(text))
      throw new Error("refusing to write evidence: it contains a dev derivation path");
    return text;
  };
}

/**
 * Loads the signer from SEAM_SIGNER: a seed phrase / secret URI, or a path to a file holding one, or a polkadot-js
 * JSON keystore (password in SEAM_SIGNER_PASSWORD). Returns a closure over the key: callers can sign, nobody can read it.
 * The raw values are only exposed through `secrets` so the evidence guard can refuse to write them.
 */
export async function loadSigner(env = process.env) {
  const raw = env.SEAM_SIGNER;
  if (!raw) return undefined;
  await cryptoWaitReady();
  const scheme = env.SEAM_SIGNER_SCHEME ?? "sr25519";
  const keyring = new Keyring({ type: scheme });
  const fromFile = existsSync(raw);
  const text = (fromFile ? readFileSync(raw, "utf8") : raw).trim();
  let pair;
  if (text.startsWith("{")) {
    const json = JSON.parse(text);
    pair = keyring.createFromJson(json);
    pair.unlock(env.SEAM_SIGNER_PASSWORD ?? "");
  } else pair = keyring.addFromUri(text);
  return {
    scheme,
    publicKey: pair.publicKey,
    secrets: [text, env.SEAM_SIGNER_PASSWORD],
    addressFor: (ss58) => encodeAddress(pair.publicKey, ss58),
    sign: (bytesHex) => u8aToHex(pair.sign(hexToU8a(bytesHex), { withType: true })),
  };
}

/** payload signer for adapter.walletFrom: SEAM hands the payload out, the closure signs, SEAM verifies and assembles. */
export const payloadSigner = (signer, facts) => async (payload) => ({
  signature: signer.sign(signBytesOf(payload, facts)),
});

/** Read-only: discover, refetch the fingerprint, and describe the runtime in plain terms. */
/** Weight V2 (refTime + proofSize) vs the old single-number Weight (Compact<Weight>, V13). */
export const isWeightV2 = (type) => /WeightV2/.test(type ?? "");

export async function runtimeReport(endpoint, discoverOpts = {}, { httpUrl } = {}) {
  assertNotMainnetUrl(endpoint);
  const facts = await discover(endpoint, discoverOpts);
  assertNotMainnetFacts(facts);
  const again = await refetchFingerprint(endpoint, discoverOpts);
  const rt = decodeRuntime(facts);
  const pallets = rt.metadata.asLatest.pallets.map((p) => p.name.toString());
  let rpcMethods = [];
  try {
    rpcMethods = await listRpcMethods(endpoint);
  } catch {
    /* optional */
  }
  const cap = (k) => facts.capabilities[k];
  const gasType = (k) => cap(k)?.args?.find((a) => a.name === "gas_limit")?.type;
  const callGas = gasType("Contracts.call");
  const shape = !callGas
    ? "no Contracts.call"
    : isWeightV2(callGas)
      ? "V14 (Weight V2: refTime + proofSize, storage_deposit_limit)"
      : "V13 (single Weight gas limit, no storage_deposit_limit)";
  const mdv = metadataVersionOf(facts.source.metadataHex);
  const fp = facts.fingerprint;
  const report = {
    kind: "runtime-report",
    generatedAt: new Date().toISOString(),
    endpoint: endpoint.replace(/\/\/[^@/]*@/, "//"),
    chain: {
      genesisHash: fp.genesisHash,
      specName: fp.specName,
      specVersion: fp.specVersion,
      transactionVersion: fp.transactionVersion,
      ss58Prefix: fp.ss58Prefix,
    },
    metadataVersion: mdv,
    fingerprintDigest: facts.fingerprintDigest,
    fingerprintStableOnRefetch: JSON.stringify(again) === JSON.stringify(fp),
    token: {
      symbol: fp.tokenSymbol,
      decimals: fp.tokenDecimals,
      source: discoverOpts.declaredToken
        ? "node, or declared on the command line if the node reports none"
        : "node",
    },
    pallets,
    has: Object.fromEntries(
      ["Contracts", "Revive", "Assets", "Utility", "Nfts", "Balances"].map((n) => [
        n,
        pallets.includes(n),
      ]),
    ),
    contractsCall: {
      shape,
      gasLimitType: callGas ?? null,
      argTypes: cap("Contracts.call")?.args ?? null,
    },
    reviveCall:
      cap("Revive.call")?.status === "observed"
        ? { gasLimitType: gasType("Revive.call"), argTypes: cap("Revive.call").args }
        : null,
    capabilities: Object.fromEntries(
      [
        "Assets.transfer_keep_alive",
        "Assets.mint",
        "Assets.create",
        "Contracts.call",
        "Contracts.instantiate_with_code",
        "Revive.call",
        "Utility.batch_all",
      ].map((k) => [k, cap(k)?.status ?? "not_observed"]),
    ),
    behaviour: facts.behaviour,
    rpc: {
      methods: rpcMethods.length,
      contractsCall: rpcMethods.includes("contracts_call"),
      reviveCall: rpcMethods.includes("revive_call"),
    },
    summary: "",
  };
  // Bot 2's read-only shape check (packages/compiler/scripts/v3-shape-check.mjs): called, not duplicated. Best effort.
  try {
    const out = execFileSync(
      "node",
      [
        fileURLToPath(new URL("../../compiler/scripts/v3-shape-check.mjs", import.meta.url)),
        httpUrl ?? endpoint,
        "--json",
      ],
      { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] },
    );
    report.shapeCheck = JSON.parse(out);
  } catch (e) {
    report.shapeCheck = {
      unavailable: String(e.stderr || e.message)
        .split("\n")
        .filter(Boolean)
        .slice(-2)
        .join(" "),
    };
  }
  report.summary = `${fp.specName} spec ${fp.specVersion}, metadata V${mdv}, ${pallets.length} pallets; Contracts ${report.has.Contracts ? "yes" : "no"}, Revive ${report.has.Revive ? "yes" : "no"}; contract call shape: ${shape}; token ${fp.tokenSymbol}/${fp.tokenDecimals}.`;
  return { facts, report };
}

async function nonceOf(endpoint, address) {
  return withClient(endpoint, (c) => c.send("system_accountNextIndex", [address]));
}

/**
 * Why a setup call's signed dry run refused, with the node's own detail. A chain still at its genesis block (a fresh
 * dev node) cannot pass any signed dry run: system_dryRun applies the extrinsic without initializing a new block, so
 * System.BlockHash(0) still holds frame_system's genesis placeholder (0x4545…45) instead of the genesis hash, and
 * CheckGenesis / CheckMortality sign against the real genesis hash, so the node reports BadProof. Fail closed and
 * say so; the transaction pool (which initializes block 1 first) would accept it, but SEAM does not send unchecked.
 */
export function explainRefusedDryRun(outcome, detail, checkpoint) {
  const why = detail?.detail ? ` (${detail.detail})` : "";
  const genesis =
    checkpoint?.number === 0 && /BadProof/.test(detail?.detail ?? "")
      ? "; the chain is still at its genesis block, where every signed dry run reports BadProof (System.BlockHash(0) is a placeholder until block 1 is built). Produce one block first (local dev node: scripts/devnode/past-genesis.mjs)"
      : "";
  return `signed dry run said ${outcome}${why}; nothing was sent${genesis}`;
}

/**
 * Signs one call through SEAM's signing path (signing request -> signer -> assemble, which verifies the signature),
 * runs the signed dry run, and only submits if it passed. Used for setup steps SEAM has no manifest action for.
 */
export async function sendThroughSeamSigning({
  endpoint,
  facts,
  signPayload,
  address,
  callHex,
  onStatus,
}) {
  const checkpoint = await readSigningCheckpoint(endpoint);
  const nonce = await nonceOf(endpoint, address);
  const [req] = signingRequestsForCalls([callHex], facts, {
    signer: address,
    nonce,
    mortalityBlocks: 64,
    checkpoint,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  });
  const { signature } = await signPayload(req.payload);
  const xt = assembleSignedExtrinsic(req.payload, signature, facts);
  const adapter = createPortaldotAdapter(endpoint, { facts });
  const dry = await adapter.dryRunSigned([xt]);
  if (dry[0] !== "ok")
    return {
      dryRun: dry[0],
      details: adapter.lastDryRun,
      refused: explainRefusedDryRun(dry[0], adapter.lastDryRun?.[0], checkpoint),
      txHash: undefined,
    };
  const res = await submitAndWatch(endpoint, xt, onStatus, { facts, timeoutMs: 120_000 });
  return { ...brief(res), dryRun: "ok", txHashLocal: extrinsicHash(xt) };
}

/** Weight argument in the shape this runtime wants (V14: refTime + proofSize, V13: one number). */
export function weightArg(facts, key, { refTime, proofSize }) {
  const t = facts.capabilities[key]?.args?.find((a) => a.name === "gas_limit")?.type ?? "";
  return isWeightV2(t)
    ? { refTime: BigInt(refTime), proofSize: BigInt(proofSize) }
    : BigInt(refTime);
}

/**
 * Deploys the demo contract. Signing, signed dry run and submission all use SEAM's own path. It is not a manifest
 * plan step: the compiler has no contracts.instantiate action kind yet (see docs/testnet-run.md).
 */
export async function deployThroughSeam({
  endpoint,
  facts,
  signPayload,
  address,
  bundlePath = DEMO_BUNDLE,
  wasmFile,
  ctorData = "0x",
  endowment = 0n,
  gas = { refTime: 100_000_000_000n, proofSize: 1_000_000n },
  onStatus,
}) {
  if (facts.capabilities["Contracts.instantiate_with_code"]?.status !== "observed")
    throw new Error(
      "this runtime has no Contracts.instantiate_with_code (Revive-only runtime? SEAM does not deploy through Revive yet)",
    );
  // wasmFile: a bare Wasm contract (no ink! bundle), e.g. the old-API emitter for the V13 runtime.
  const wasmHex = wasmFile ? `0x${readFileSync(wasmFile).toString("hex")}` : undefined;
  const bundle = wasmFile
    ? {
        source: { wasm: wasmHex, hash: blake2AsHex(hexToU8a(wasmHex), 256) },
        spec: { constructors: [{ label: "raw", selector: ctorData }] },
      }
    : JSON.parse(readFileSync(bundlePath, "utf8"));
  const ctor = bundle.spec.constructors.find((c) => c.label === (wasmFile ? "raw" : "new"));
  const salt = u8aToHex(new TextEncoder().encode(`seam-demo-${Date.now()}`));
  // Build the arguments by name, so the V13 shape (endowment, gas_limit, code, data, salt) and V14 both work.
  const byName = {
    value: BigInt(endowment),
    endowment: BigInt(endowment),
    gas_limit: weightArg(facts, "Contracts.instantiate_with_code", gas),
    storage_deposit_limit: null,
    code: bundle.source.wasm,
    data: ctor.selector,
    salt,
  };
  const callHex = encodeCall(
    facts,
    "Contracts",
    "instantiate_with_code",
    facts.capabilities["Contracts.instantiate_with_code"].args.map((a) => {
      if (!(a.name in byName)) throw new Error(`unknown instantiate_with_code argument ${a.name}`);
      return byName[a.name];
    }),
  );
  const r = await sendThroughSeamSigning({
    endpoint,
    facts,
    signPayload,
    address,
    callHex,
    onStatus,
  });
  const inst = (r.events ?? []).find((e) => e.startsWith("Contracts.Instantiated("));
  const args = inst ? inst.slice("Contracts.Instantiated(".length, -1).split(", ") : undefined;
  return {
    ...r,
    codeHash: bundle.source.hash,
    constructor: ctor.selector,
    contract: args?.[1],
    ok: Boolean(args && r.success),
  };
}

const stateOf = async (endpoint, facts, assetId, accounts) => {
  const dec = decodeRuntime(facts);
  const q = dec.decorated().query;
  return withClient(endpoint, async (c) => {
    const bal = async (who) => {
      const v = await c.send("state_getStorage", [storageKey(q.assets.account, assetId, who)]);
      if (!v) return "0";
      const t = dec.registry.lookup.getTypeDef(q.assets.account.meta.type.asMap.value).type;
      return dec.registry.createType(t, hexToU8a(v)).toJSON().balance.toString();
    };
    const supplyRaw = await c.send("state_getStorage", [storageKey(q.assets.asset, assetId)]);
    let supply = null;
    if (supplyRaw) {
      const t = dec.registry.lookup.getTypeDef(q.assets.asset.meta.type.asMap.value).type;
      supply = dec.registry.createType(t, hexToU8a(supplyRaw)).toJSON().supply.toString();
    }
    const head = await c.send("chain_getHeader", []);
    return {
      block: parseInt(head.number, 16),
      signerNonce: await c.send("system_accountNextIndex", [accounts.signer]),
      exists: supplyRaw !== null,
      balances: {
        signer: await bal(accounts.signer),
        recipientA: await bal(accounts.a),
        recipientB: await bal(accounts.b),
      },
      supply,
    };
  });
};

/** Creates asset `assetId` if missing and tops the signer up so the flows can pay and mint. */
export async function ensureAsset({ endpoint, facts, signPayload, address, assetId, log }) {
  const accounts = { signer: address, a: address, b: address };
  const st = await stateOf(endpoint, facts, assetId, accounts);
  const steps = [];
  if (!st.exists) {
    const create = await sendThroughSeamSigning({
      endpoint,
      facts,
      signPayload,
      address,
      callHex: encodeCall(facts, "Assets", "create", [assetId, { Id: address }, 1]),
    });
    steps.push({ what: `Assets.create(${assetId}, signer, min_balance 1)`, ...create });
    if (!create.success)
      throw new Error(
        `Assets.create failed: ${JSON.stringify(create.refused ?? create.dispatchError ?? create.error)}`,
      );
  }
  if (BigInt(st.balances.signer) < 10_000_000_000n) {
    const mint = await sendThroughSeamSigning({
      endpoint,
      facts,
      signPayload,
      address,
      callHex: encodeCall(facts, "Assets", "mint", [assetId, { Id: address }, "1000000000000"]),
    });
    steps.push({ what: `Assets.mint(${assetId}, signer, 1000000000000)`, ...mint });
    if (!mint.success)
      throw new Error(
        `Assets.mint failed (is the signer the admin of asset ${assetId}?): ${JSON.stringify(mint.refused ?? mint.dispatchError ?? mint.error)}`,
      );
  } else steps.push({ what: `asset ${assetId} already funds the signer, skipped` });
  log?.(`asset ${assetId} ready`);
  return steps;
}

/**
 * Assets.create makes a non-sufficient asset, so a recipient needs a little native balance before it can hold the
 * asset. Plain setup transfers from the signer (signed dry run first), recorded as setup steps.
 */
export async function fundRecipients({ endpoint, facts, signPayload, address, recipients }) {
  // Twice the existential deposit (read from the runtime), so the new account survives.
  const ed = BigInt(
    decodeRuntime(facts).decorated().consts.balances?.existentialDeposit?.toString() ?? 0,
  );
  const amount =
    ed > 0n ? ed * 2n : 10n ** BigInt(Math.max(facts.fingerprint.tokenDecimals - 2, 0));
  const method =
    facts.capabilities["Balances.transfer_keep_alive"]?.status === "observed"
      ? "transfer_keep_alive"
      : "transfer";
  const steps = [];
  for (const to of recipients) {
    const r = await sendThroughSeamSigning({
      endpoint,
      facts,
      signPayload,
      address,
      callHex: encodeCall(facts, "Balances", method, [{ Id: to }, amount.toString()]),
    });
    steps.push({ what: `Balances.${method}(${to}, ${amount})`, ...r });
    if (!r.success)
      throw new Error(
        `could not fund recipient ${to}: ${JSON.stringify(r.refused ?? r.dispatchError ?? r.error)}`,
      );
  }
  return steps;
}

/** Fresh recipients: generated here, only their public addresses are used or recorded. */
export async function freshRecipients(ss58) {
  await cryptoWaitReady();
  const kr = new Keyring({ type: "sr25519", ss58Format: ss58 });
  return [
    kr.addFromMnemonic(mnemonicGenerate()).address,
    kr.addFromMnemonic(mnemonicGenerate()).address,
  ];
}

const gasFor = (facts) =>
  isWeightV2(facts.capabilities["Contracts.call"]?.args?.find((a) => a.name === "gas_limit")?.type)
    ? { gasLimit: "5000000000", proofSize: "1000000" }
    : { gasLimit: "5000000000", v13: true };

/**
 * SEAM-004: what the demo contract step must have done, committed from the manifest values before the run (the signer
 * is the Settled event's caller). A raw-call runtime (--wasm) has no ABI to derive it from, so there the contract step
 * stays unproven (the SDK reports effect_unproven) and a sequential run stops after it.
 */
export function flowEffects({ address, rawCall }) {
  return rawCall ? undefined : { call: settleEffect(address) };
}

/**
 * The three flows. `save(rel, value)` writes sanitized evidence. Returns a summary of what ran.
 * Rollback includes a TEST-ONLY direct submission of the one failing signed batch the gate refused, to observe the
 * chain's own rollback; it costs a fee. All other submissions go through the SEAM gate.
 */
export async function runAllFlows({
  endpoint,
  discoverOpts,
  signer,
  signPayloadFor,
  address,
  assetId,
  contract,
  recipients,
  env,
  save,
  log = () => {},
  only,
  rawCall,
}) {
  const [bob, charlie] = recipients;
  const accounts = { signer: address, a: bob, b: charlie };
  const out = {};
  const want = (n) => !only || only.includes(n);
  const common = (facts) => ({
    callData: rawCall?.data,
    alice: address,
    bob,
    charlie,
    contract,
    genesis: facts.fingerprint.genesisHash,
    assetId,
    gas: gasFor(facts),
    specVersion: facts.fingerprint.specVersion,
  });
  const policyFor = (extra = {}) =>
    devPolicy({
      bob,
      charlie,
      contract,
      assetId,
      demo: !rawCall,
      rawSelector: rawCall?.data?.slice(0, 10),
      overrides: { maxGasLimit: "100000000000", ...extra },
    });
  const effects = flowEffects({ address, rawCall });

  if (want("sequential")) {
    const facts = await discover(endpoint, discoverOpts);
    const manifest = devManifest(common(facts));
    const policy = policyFor();
    const r = await runFlow({
      facts,
      manifest,
      policy,
      signPayload: signPayloadFor(facts),
      env: { ...env, endpoint },
      atomic: false,
      effects,
    });
    const file = save(`runs/sequential-${Date.now()}.json`, {
      kind: "sequential",
      recordingVersion: 2,
      ranAt: new Date().toISOString(),
      requireSignedDryRun: policy.requireSignedDryRun,
      ...r,
    });
    out.sequential = {
      file,
      result: r.run?.receipt?.result ?? r.stage,
      steps: r.run?.receipt?.steps.map((s) => ({
        id: s.actionId,
        status: s.status,
        tx: s.txHash,
        block: s.block?.number,
      })),
    };
    log(`sequential: ${out.sequential.result}`);
  }

  let rollbackVerified = false;
  let rollbackProof;
  if (want("rollback") || want("atomic")) {
    const facts = await discover(endpoint, discoverOpts);
    const dec = decodeRuntime(facts);
    const manifest = devManifest({
      ...common(facts),
      // SEAM-012: the batch covers every kind of the atomic plan (transfer, contract call, mint), then fails.
      actions: rollbackActions({
        bob,
        charlie,
        contract,
        callData: rawCall?.data,
        assetId,
        gas: gasFor(facts),
      }),
    });
    const policy = policyFor({
      allowedModes: ["sequential", "atomic_verified", "atomic_unverified"],
      maxAmountPerAsset: { [String(assetId)]: "1000000000000000" },
    });
    const before = await stateOf(endpoint, facts, assetId, accounts);
    let signed;
    const r = await runFlow({
      facts,
      manifest,
      policy,
      signPayload: signPayloadFor(facts),
      env: { ...env, endpoint },
      atomic: true,
      compileOptions: { allowAtomicUnverified: true },
      onSigned: (txs) => {
        signed = txs;
      },
    });
    const afterGate = await stateOf(endpoint, facts, assetId, accounts);
    if (r.run?.ok !== false || r.run.stage !== "submit_gate")
      throw new Error(
        `expected SEAM's gate to block the failing batch, got ${JSON.stringify(r.run ?? r.stage)}`,
      );
    const directStatuses = [];
    const direct = await submitAndWatch(
      endpoint,
      signed[0],
      (u) =>
        directStatuses.push({
          status: u.status,
          txHash: u.txHash,
          blockHash: u.blockHash,
          at: new Date().toISOString(),
        }),
      { facts, timeoutMs: 120_000 },
    );
    signed = undefined;
    const after = await stateOf(endpoint, facts, assetId, accounts);
    const ev = direct.inclusion?.events ?? [];
    const innerEffects = ev.filter(
      (e) =>
        (e.pallet === "Assets" && ["Transferred", "Issued"].includes(e.name)) ||
        (e.pallet === "Contracts" && ["ContractEmitted", "Called"].includes(e.name)) ||
        (e.pallet === "Utility" && e.name !== "BatchInterrupted"),
    );
    const rolledBack =
      direct.inclusion?.success === false &&
      innerEffects.length === 0 &&
      JSON.stringify(after.balances) === JSON.stringify(before.balances);
    const gate = r.gateChecks.find((g) => g.phase === "blocked");
    rollbackVerified = rolledBack;
    const rb = {
      kind: "batch_all-rollback",
      recordingVersion: 2,
      ranAt: new Date().toISOString(),
      ...r,
      planMode: r.plan.mode,
      seamGate: {
        stage: r.run.stage,
        ok: r.run.ok,
        reason: r.run.reason,
        reasons: gate?.check.reasons ?? r.run.check?.reasons,
        passed: gate?.check.passed,
        dryRun: gate?.dryRun,
        nothingSent: afterGate.signerNonce === before.signerNonce,
      },
      directSubmit: {
        note: "test-only bypass of the gate: the same signed bytes the gate refused",
        statuses: directStatuses,
        decodedEvents: direct.inclusion?.events,
        ...brief(direct),
      },
      state: { before, afterGate, after },
      innerEffects: innerEffects.map((e) => `${e.pallet}.${e.name}`),
      batchAllRollback: rolledBack ? "verified" : "unknown",
    };
    if (rolledBack) rollbackProof = rollbackProofFromEvidence(facts, rb);
    if (want("rollback")) {
      const file = save(`runs/rollback-${Date.now()}.json`, rb);
      out.rollback = {
        file,
        result: rb.batchAllRollback,
        directTx: direct.txHash,
        dispatchError: direct.inclusion?.dispatchError,
      };
      log(`rollback: ${rb.batchAllRollback}`);
    }
    void dec;
  }

  if (want("atomic")) {
    if (!rollbackVerified) {
      out.atomic = {
        skipped:
          "rollback was not verified on this runtime, so the verified atomic plan is not allowed",
      };
    } else {
      const facts = await discover(endpoint, {
        ...discoverOpts,
        batchAllRollback: "verified",
        batchAllRollbackProof: rollbackProof,
      });
      const manifest = devManifest({ ...common(facts), atomic: true });
      const policy = policyFor();
      const r = await runFlow({
        facts,
        manifest,
        policy,
        signPayload: signPayloadFor(facts),
        env: { ...env, endpoint },
        atomic: true,
        effects,
      });
      const file = save(`runs/atomic-${Date.now()}.json`, {
        kind: "atomic",
        recordingVersion: 2,
        ranAt: new Date().toISOString(),
        requireSignedDryRun: policy.requireSignedDryRun,
        rollbackEvidence: out.rollback?.file ? out.rollback.file.split("/").pop() : undefined,
        ...r,
      });
      out.atomic = {
        file,
        mode: r.plan?.mode,
        result: r.run?.receipt?.result ?? r.stage,
        steps: r.run?.receipt?.steps.map((s) => ({
          id: s.actionId,
          status: s.status,
          tx: s.txHash,
          block: s.block?.number,
        })),
      };
      log(`atomic: ${out.atomic.result}`);
    }
  }
  return out;
}

export function makeSaver(dir, guardedJson) {
  return (rel, value) => {
    const text = guardedJson(value);
    const path = `${dir}/${rel}`;
    mkdirSync(path.replace(/\/[^/]+$/, ""), { recursive: true });
    writeFileSync(path, text);
    return path;
  };
}
export { ABIS };
