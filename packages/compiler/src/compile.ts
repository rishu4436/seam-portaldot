import { stringCamelCase } from '@polkadot/util';
import { DOMAIN, NotCanonicalError, digestJson } from './canonical.js';
import { parseH160, parseNativeAddress } from './address.js';
import { computeFingerprintDigest } from './facts.js';
import { loadRuntime, type LoadedRuntime } from './runtime.js';
import {
  SeamCompileError,
  type ActionKind,
  type Capability,
  type CompileIssue,
  type CompileOptions,
  type Hex,
  type Manifest,
  type ManifestAction,
  type Plan,
  type PlanMode,
  type PlanSigner,
  type PlanStep,
  type RuntimeFacts
} from './types.js';

/** SEAM action kind -> runtime capability. Indexes are never hard-coded; they come from metadata. */
export const KIND_TO_CAPABILITY: Record<ActionKind, string> = {
  'assets.transfer': 'Assets.transfer_keep_alive',
  'assets.mint': 'Assets.mint',
  'contracts.call': 'Contracts.call',
  'revive.call': 'Revive.call',
  'nfts.mint': 'Nfts.mint'
};

export const BATCH_CAPABILITY = 'Utility.batch_all';

/** Manifest arg names accepted per kind (anything else is rejected to catch typos). */
const ARG_SCHEMA: Record<ActionKind, { required: string[]; optional: string[] }> = {
  'assets.transfer': { required: ['assetId', 'amount', 'recipient'], optional: [] },
  'assets.mint': { required: ['assetId', 'amount', 'recipient'], optional: [] },
  'contracts.call': { required: ['contract', 'value', 'gasLimit', 'data'], optional: [] },
  'revive.call': { required: ['contract', 'value', 'data'], optional: ['gasLimit', 'storageDepositLimit'] },
  'nfts.mint': { required: ['collection', 'item', 'recipient'], optional: [] }
};

/**
 * Which runtime argument each SEAM arg feeds, by metadata arg name.
 * If the runtime's call has an argument not listed here, the step is unavailable
 * (SEAM never guesses a value for an argument it does not understand).
 */
const ARG_BINDINGS: Partial<Record<ActionKind, Record<string, string>>> = {
  'assets.transfer': { id: 'assetId', target: 'recipient', amount: 'amount' },
  'assets.mint': { id: 'assetId', beneficiary: 'recipient', amount: 'amount' },
  'contracts.call': { dest: 'contract', value: 'value', gasLimit: 'gasLimit', data: 'data' }
};
// Binding keys are camelCase; metadata names (snake_case) are camelCased before lookup.

const UINT_RE = /^(0|[1-9][0-9]*)$/;
const HEX_BYTES_RE = /^0x([0-9a-fA-F]{2})*$/;
const MAX_U128 = (1n << 128n) - 1n;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Base-unit amount: a decimal string of digits. Numbers (incl. floats) are rejected. */
function parseAmount(v: unknown, path: string, issues: CompileIssue[]): string | undefined {
  if (typeof v === 'number') {
    issues.push({
      code: 'AMOUNT_INVALID',
      path,
      message: `amounts must be base-unit strings like "1000000", got the number ${v}${Number.isInteger(v) ? '' : ' (floats are never allowed)'}`
    });
    return undefined;
  }
  if (typeof v !== 'string' || !UINT_RE.test(v)) {
    issues.push({ code: 'AMOUNT_INVALID', path, message: 'amount must be a string of digits in base units, with no sign, decimal point or leading zeros' });
    return undefined;
  }
  if (BigInt(v) > MAX_U128) {
    issues.push({ code: 'AMOUNT_INVALID', path, message: 'amount exceeds u128' });
    return undefined;
  }
  return v;
}

/** Integer identifiers (assetId, collection, item): digit string or non-negative safe integer. Normalised to a string. */
function parseId(v: unknown, path: string, issues: CompileIssue[]): string | undefined {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return String(v);
  if (typeof v === 'string' && UINT_RE.test(v)) return v;
  issues.push({ code: 'MANIFEST_INVALID', path, message: 'must be a non-negative integer or a string of digits' });
  return undefined;
}

function parseHexBytes(v: unknown, path: string, issues: CompileIssue[]): Hex | undefined {
  if (typeof v === 'string' && HEX_BYTES_RE.test(v)) return v.toLowerCase() as Hex;
  issues.push({ code: 'MANIFEST_INVALID', path, message: 'must be 0x-prefixed hex bytes (e.g. ink! selector + SCALE-encoded args)' });
  return undefined;
}

interface ValidatedAction {
  action: ManifestAction;
  /** Normalised values used for encoding and display. */
  values: Record<string, string>;
  /** Values as passed to polkadot.js (addresses as AccountId hex). */
  encodeValues: Record<string, string>;
}

function validateAction(
  action: ManifestAction,
  index: number,
  ss58Prefix: number,
  issues: CompileIssue[]
): ValidatedAction | undefined {
  const base = `actions[${index}]`;
  const schema = ARG_SCHEMA[action.kind];
  if (!isObject(action.args)) {
    issues.push({ code: 'MANIFEST_INVALID', path: `${base}.args`, message: 'args must be an object' });
    return undefined;
  }
  const before = issues.length;
  for (const k of Object.keys(action.args)) {
    if (!schema.required.includes(k) && !schema.optional.includes(k)) {
      issues.push({ code: 'MANIFEST_INVALID', path: `${base}.args.${k}`, message: `unknown argument "${k}" for ${action.kind}` });
    }
  }
  for (const k of schema.required) {
    if (action.args[k] === undefined) {
      issues.push({ code: 'MANIFEST_INVALID', path: `${base}.args.${k}`, message: `missing required argument "${k}" for ${action.kind}` });
    }
  }
  if (issues.length > before) return undefined;

  const a = action.args;
  const p = (k: string) => `${base}.args.${k}`;
  const values: Record<string, string> = {};
  const encodeValues: Record<string, string> = {};
  const set = (k: string, display: string | undefined, enc: string | undefined = display) => {
    if (display === undefined || enc === undefined) return;
    values[k] = display;
    encodeValues[k] = enc;
  };

  switch (action.kind) {
    case 'assets.transfer':
    case 'assets.mint': {
      set('assetId', parseId(a.assetId, p('assetId'), issues));
      set('amount', parseAmount(a.amount, p('amount'), issues));
      const r = parseNativeAddress(a.recipient, ss58Prefix, p('recipient'), issues);
      if (r) {
        set('recipient', r.ss58, r.accountId);
        values.recipientAccountId = r.accountId;
      }
      break;
    }
    case 'contracts.call': {
      const c = parseNativeAddress(a.contract, ss58Prefix, p('contract'), issues);
      if (c) {
        set('contract', c.ss58, c.accountId);
        values.contractAccountId = c.accountId;
      }
      set('value', parseAmount(a.value, p('value'), issues));
      set('gasLimit', parseAmount(a.gasLimit, p('gasLimit'), issues));
      set('data', parseHexBytes(a.data, p('data'), issues));
      break;
    }
    case 'revive.call': {
      set('contract', parseH160(a.contract, p('contract'), issues));
      set('value', parseAmount(a.value, p('value'), issues));
      set('data', parseHexBytes(a.data, p('data'), issues));
      if (a.gasLimit !== undefined) set('gasLimit', parseAmount(a.gasLimit, p('gasLimit'), issues));
      if (a.storageDepositLimit !== undefined) set('storageDepositLimit', parseAmount(a.storageDepositLimit, p('storageDepositLimit'), issues));
      break;
    }
    case 'nfts.mint': {
      set('collection', parseId(a.collection, p('collection'), issues));
      set('item', parseId(a.item, p('item'), issues));
      const r = parseNativeAddress(a.recipient, ss58Prefix, p('recipient'), issues);
      if (r) {
        set('recipient', r.ss58, r.accountId);
        values.recipientAccountId = r.accountId;
      }
      break;
    }
  }
  return issues.length > before ? undefined : { action, values, encodeValues };
}

function validateManifestShape(m: unknown, issues: CompileIssue[]): m is Manifest {
  if (!isObject(m)) {
    issues.push({ code: 'MANIFEST_INVALID', message: 'manifest must be an object' });
    return false;
  }
  if (m.version !== 1) issues.push({ code: 'MANIFEST_INVALID', path: 'version', message: 'only manifest version 1 is supported' });
  if (!isObject(m.signer) || typeof m.signer.value !== 'string' || !['ss58', 'accountId32', 'h160'].includes(m.signer.type as string)) {
    issues.push({ code: 'MANIFEST_INVALID', path: 'signer', message: "signer must be {type: 'ss58'|'accountId32'|'h160', value}" });
  }
  if (m.chain !== undefined && (!isObject(m.chain) || typeof m.chain.genesisHash !== 'string' || typeof m.chain.specVersion !== 'number')) {
    issues.push({ code: 'MANIFEST_INVALID', path: 'chain', message: 'chain must be {genesisHash, specVersion}' });
  }
  if (!Array.isArray(m.actions) || m.actions.length === 0) {
    issues.push({ code: 'MANIFEST_INVALID', path: 'actions', message: 'actions must be a non-empty array' });
    return false;
  }
  const ids = new Set<string>();
  m.actions.forEach((a, i) => {
    if (!isObject(a)) {
      issues.push({ code: 'MANIFEST_INVALID', path: `actions[${i}]`, message: 'action must be an object' });
      return;
    }
    if (typeof a.id !== 'string' || a.id.length === 0) {
      issues.push({ code: 'MANIFEST_INVALID', path: `actions[${i}].id`, message: 'action id must be a non-empty string' });
    } else if (ids.has(a.id)) {
      issues.push({ code: 'MANIFEST_INVALID', path: `actions[${i}].id`, message: `duplicate action id "${a.id}"` });
    } else ids.add(a.id);
    if (!(typeof a.kind === 'string' && a.kind in KIND_TO_CAPABILITY)) {
      issues.push({ code: 'MANIFEST_INVALID', path: `actions[${i}].kind`, message: `unknown kind "${String(a.kind)}"; expected one of ${Object.keys(KIND_TO_CAPABILITY).join(', ')}` });
    }
    if (a.preferredMode !== undefined && a.preferredMode !== 'atomic' && a.preferredMode !== 'sequential') {
      issues.push({ code: 'MANIFEST_INVALID', path: `actions[${i}].preferredMode`, message: "preferredMode must be 'atomic' or 'sequential'" });
    }
  });
  return true;
}

/** Checks the facts are internally consistent and loads the runtime they describe. */
function validateFacts(facts: RuntimeFacts, issues: CompileIssue[]): LoadedRuntime | undefined {
  const bad = (message: string) => issues.push({ code: 'FACTS_INVALID', message });
  if (!isObject(facts) || !isObject(facts.fingerprint) || !isObject(facts.capabilities) || !isObject(facts.source)) {
    bad('facts must include fingerprint, capabilities and source');
    return undefined;
  }
  if (computeFingerprintDigest(facts.fingerprint) !== facts.fingerprintDigest) {
    bad('fingerprintDigest does not match the fingerprint fields');
  }
  if (!['verified', 'unknown', 'not_supported'].includes(facts.behaviour?.batchAllRollback)) {
    bad("behaviour.batchAllRollback must be 'verified', 'unknown' or 'not_supported'");
  }
  let rt: LoadedRuntime;
  try {
    rt = loadRuntime(facts.source.metadataHex, facts.source.typesBundle);
  } catch (e) {
    bad(`metadata or pinned types could not be loaded: ${(e as Error).message}`);
    return undefined;
  }
  if (rt.metadataHash !== facts.fingerprint.metadataHash) bad('source.metadataHex does not hash to fingerprint.metadataHash');
  if (rt.typesBundleHash !== facts.fingerprint.typesBundleHash) bad('source.typesBundle does not hash to fingerprint.typesBundleHash');
  return rt;
}

function capabilityOrigin(rt: LoadedRuntime, capability: string, cap: Capability): string | undefined {
  // Cross-check: the indexes in facts must point at this exact pallet/call in the metadata.
  const [palletName, callName] = capability.split('.');
  const pallet = rt.metadata.asLatest.pallets.find((p) => p.index.toNumber() === cap.palletIndex);
  if (!pallet || pallet.name.toString() !== palletName) {
    return `facts say ${capability} is at pallet index ${cap.palletIndex}, but the metadata has ${pallet ? pallet.name.toString() : 'no pallet'} there`;
  }
  try {
    const fn = rt.registry.findMetaCall(new Uint8Array([cap.palletIndex!, cap.callIndex!]));
    if (fn.meta.name.toString() !== callName) {
      return `facts say ${capability} is call index ${cap.callIndex}, but the metadata has ${palletName}.${fn.meta.name.toString()} there`;
    }
  } catch {
    return `metadata has no call at index [${cap.palletIndex}, ${cap.callIndex}]`;
  }
  return undefined;
}

function bitLengthOf(rt: LoadedRuntime, type: string): number | undefined {
  const inner = type.replace(/^Compact<(.+)>$/, '$1');
  try {
    const t = rt.registry.createType(inner as any) as any;
    return typeof t.bitLength === 'function' ? t.bitLength() : undefined;
  } catch {
    return undefined;
  }
}

interface EncodeResult {
  ok: boolean;
  encodedCall?: Hex;
  reason?: string;
  rangeIssue?: CompileIssue;
}

function encodeStep(rt: LoadedRuntime, kind: ActionKind, cap: Capability, v: ValidatedAction, index: number): EncodeResult {
  const bindings = ARG_BINDINGS[kind];
  const capability = KIND_TO_CAPABILITY[kind];
  if (!bindings) return { ok: false, reason: `SEAM has no encoder for ${capability} yet` };
  const fn = rt.registry.findMetaCall(new Uint8Array([cap.palletIndex!, cap.callIndex!]));
  const metaArgs = fn.meta.args.map((a) => ({ name: stringCamelCase(a.name.toString()), type: a.type.toString() }));
  const unknownArgs = metaArgs.filter((a) => !(a.name in bindings)).map((a) => a.name);
  if (unknownArgs.length) {
    return { ok: false, reason: `${capability} on this runtime takes argument(s) SEAM cannot fill: ${unknownArgs.join(', ')}` };
  }
  const ordered: unknown[] = [];
  for (const a of metaArgs) {
    const seamKey = bindings[a.name]!;
    const raw = v.encodeValues[seamKey]!;
    const bits = /^(Compact<)?(u\d+|[A-Za-z]*(Balance|Weight|AssetId)[A-Za-z]*)>?$/.test(a.type) ? bitLengthOf(rt, a.type) : undefined;
    if (bits !== undefined && BigInt(raw) >= 1n << BigInt(bits)) {
      return {
        ok: false,
        rangeIssue: { code: 'AMOUNT_INVALID', path: `actions[${index}].args.${seamKey}`, message: `${raw} does not fit ${a.type} (${bits} bits) on this runtime` }
      };
    }
    const rawType = rt.registry.createType(a.type as any).toRawType();
    ordered.push(rawType.includes('"Id":"AccountId"') ? { Id: raw } : raw);
  }
  try {
    return { ok: true, encodedCall: fn(...ordered).toHex() as Hex };
  } catch (e) {
    return {
      ok: false,
      rangeIssue: { code: 'ENCODE_FAILED', path: `actions[${index}]`, message: `could not encode ${capability}: ${(e as Error).message}` }
    };
  }
}

function signerFor(m: Manifest, ss58Prefix: number, issues: CompileIssue[]): PlanSigner | undefined {
  const s = m.signer;
  if (s.type === 'h160') {
    if (!m.actions.every((a) => a.kind === 'revive.call')) {
      issues.push({ code: 'ADDRESS_TYPE', path: 'signer', message: 'an h160 signer can only be used for revive.call; native calls need an AccountId32 signer' });
      return undefined;
    }
    const h = parseH160(s.value, 'signer.value', issues);
    return h ? { type: 'h160', value: h, publicKey: h } : undefined;
  }
  if (s.ss58Prefix !== undefined && s.ss58Prefix !== ss58Prefix) {
    issues.push({ code: 'SS58_PREFIX', path: 'signer.ss58Prefix', message: `signer declares SS58 prefix ${s.ss58Prefix}, this chain uses ${ss58Prefix}` });
    return undefined;
  }
  if (s.type === 'ss58' && s.value.startsWith('0x')) {
    issues.push({ code: 'ADDRESS_TYPE', path: 'signer.value', message: "signer type is 'ss58' but the value is hex" });
    return undefined;
  }
  if (s.type === 'accountId32' && !/^0x[0-9a-fA-F]{64}$/.test(s.value)) {
    issues.push({ code: 'ADDRESS_TYPE', path: 'signer.value', message: "signer type is 'accountId32' but the value is not 0x + 64 hex chars" });
    return undefined;
  }
  const a = parseNativeAddress(s.value, ss58Prefix, 'signer.value', issues);
  if (!a) return undefined;
  return { type: s.type, value: s.type === 'ss58' ? a.ss58 : a.accountId, publicKey: a.accountId };
}

function selectMode(
  steps: PlanStep[],
  actions: ManifestAction[],
  facts: RuntimeFacts,
  options: CompileOptions
): { mode: PlanMode; modeReason: string } {
  const unavailable = steps.filter((s) => s.status === 'unavailable');
  if (unavailable.length) {
    return { mode: 'unavailable', modeReason: `Cannot run: ${unavailable.map((s) => `step "${s.actionId}": ${s.reason}`).join('; ')}` };
  }
  if (actions.some((a) => a.preferredMode === 'sequential')) {
    return { mode: 'sequential', modeReason: 'The manifest asks for sequential execution.' };
  }
  const wantsAtomic = actions.some((a) => a.preferredMode === 'atomic');
  const fallback = (why: string) => ({
    mode: 'sequential' as const,
    modeReason: wantsAtomic ? `Atomic execution was requested but is not available: ${why}. Steps run one after another; a failure stops later steps.` : `${why}. Steps run one after another; a failure stops later steps.`
  });
  const batch = facts.capabilities[BATCH_CAPABILITY];
  if (!batch || batch.status !== 'observed') return fallback(`${BATCH_CAPABILITY} is not on this runtime`);
  const rollback = facts.behaviour.batchAllRollback;
  if (rollback === 'verified') {
    return { mode: 'atomic_verified', modeReason: `All steps go in one ${BATCH_CAPABILITY}; rollback on failure has been verified on this runtime.` };
  }
  if (rollback === 'unknown') {
    if (options.allowAtomicUnverified) {
      return { mode: 'atomic_unverified', modeReason: `All steps go in one ${BATCH_CAPABILITY}; rollback on failure has NOT been verified on this runtime (allowed by allowAtomicUnverified).` };
    }
    return fallback(`${BATCH_CAPABILITY} exists but its rollback on failure is not verified (set allowAtomicUnverified to batch anyway)`);
  }
  return fallback(`${BATCH_CAPABILITY} does not roll back on failure on this runtime`);
}

/**
 * Compiles a Manifest against RuntimeFacts into a deterministic Plan.
 * Throws SeamCompileError (with every issue found) for invalid input.
 * Returns a plan with mode 'unavailable' when the runtime cannot do what is asked.
 * Pure and offline: no network, no clock, no randomness.
 */
export function compile(manifest: Manifest, facts: RuntimeFacts, options: CompileOptions = {}): Plan {
  const issues: CompileIssue[] = [];
  if (!validateManifestShape(manifest, issues) || issues.length) throw new SeamCompileError(issues);

  const rt = validateFacts(facts, issues);
  if (!rt || issues.length) throw new SeamCompileError(issues);
  const fp = facts.fingerprint;

  if (manifest.chain) {
    if (manifest.chain.genesisHash.toLowerCase() !== fp.genesisHash.toLowerCase()) {
      issues.push({ code: 'CHAIN_MISMATCH', path: 'chain.genesisHash', message: `manifest targets genesis ${manifest.chain.genesisHash}, connected chain is ${fp.genesisHash}` });
    }
    if (manifest.chain.specVersion !== fp.specVersion) {
      issues.push({ code: 'CHAIN_MISMATCH', path: 'chain.specVersion', message: `manifest targets spec ${manifest.chain.specVersion}, runtime is spec ${fp.specVersion}` });
    }
  }

  const signer = signerFor(manifest, fp.ss58Prefix, issues);
  const validated = manifest.actions.map((a, i) => validateAction(a, i, fp.ss58Prefix, issues));
  if (issues.length) throw new SeamCompileError(issues);

  let manifestDigest: Hex;
  try {
    manifestDigest = digestJson(DOMAIN.manifest, manifest);
  } catch (e) {
    if (e instanceof NotCanonicalError) throw new SeamCompileError([{ code: 'NOT_CANONICAL', path: e.path, message: e.message }]);
    throw e;
  }

  const steps: PlanStep[] = [];
  validated.forEach((v, i) => {
    const action = v!.action;
    const capability = KIND_TO_CAPABILITY[action.kind];
    const cap = facts.capabilities[capability];
    const step: PlanStep = {
      actionId: action.id,
      kind: action.kind,
      capability,
      palletIndex: null,
      callIndex: null,
      decodedArgs: v!.values,
      encodedCall: null,
      status: 'unavailable'
    };
    if (!cap || cap.status === 'not_observed') {
      step.reason = `${capability} is not on this runtime (spec ${fp.specVersion})`;
    } else if (cap.status === 'unknown') {
      step.reason = `${capability} could not be confirmed on this runtime (spec ${fp.specVersion}); discovery did not finish reading it`;
    } else if (!Number.isInteger(cap.palletIndex) || !Number.isInteger(cap.callIndex)) {
      issues.push({ code: 'FACTS_INVALID', message: `${capability} is observed but has no pallet/call index` });
    } else {
      const mismatch = capabilityOrigin(rt, capability, cap);
      if (mismatch) {
        issues.push({ code: 'FACTS_INVALID', message: mismatch });
      } else {
        const r = encodeStep(rt, action.kind, cap, v!, i);
        step.palletIndex = cap.palletIndex!;
        step.callIndex = cap.callIndex!;
        if (r.rangeIssue) issues.push(r.rangeIssue);
        else if (r.ok) {
          step.encodedCall = r.encodedCall!;
          step.status = 'ok';
        } else step.reason = r.reason;
      }
    }
    if (step.reason === undefined) delete step.reason;
    steps.push(step);
  });
  if (issues.length) throw new SeamCompileError(issues);

  const effectiveActions = manifest.actions;
  let { mode, modeReason } = selectMode(steps, effectiveActions, facts, options);
  if (steps.length === 1 && (mode === 'atomic_verified' || mode === 'atomic_unverified')) {
    mode = 'sequential';
    modeReason = 'Single step: it is atomic on its own, so no batch is needed.';
  }

  const plan: Omit<Plan, 'planDigest'> & { planDigest?: Hex } = {
    planVersion: 1,
    manifestDigest,
    fingerprintDigest: facts.fingerprintDigest,
    signer: signer!,
    mode,
    modeReason,
    steps
  };

  if (mode === 'atomic_verified' || mode === 'atomic_unverified') {
    const batch = facts.capabilities[BATCH_CAPABILITY]!;
    const mismatch = capabilityOrigin(rt, BATCH_CAPABILITY, batch);
    if (mismatch) throw new SeamCompileError([{ code: 'FACTS_INVALID', message: mismatch }]);
    const fn = rt.registry.findMetaCall(new Uint8Array([batch.palletIndex!, batch.callIndex!]));
    const inner = steps.map((s) => rt.registry.createType('Call', s.encodedCall!));
    plan.outerCall = {
      capability: BATCH_CAPABILITY,
      palletIndex: batch.palletIndex!,
      callIndex: batch.callIndex!,
      encodedCall: fn(inner).toHex() as Hex
    };
  }

  const planDigest = digestJson(DOMAIN.plan, plan);
  return { ...plan, planDigest } as Plan;
}

/** Recomputes a plan's digest (e.g. for policy/approval to check it was not altered). */
export function computePlanDigest(plan: Plan): Hex {
  const { planDigest: _ignored, ...rest } = plan;
  return digestJson(DOMAIN.plan, rest);
}

/** Digest of a manifest exactly as compile() computes it. */
export function computeManifestDigest(manifest: Manifest): Hex {
  return digestJson(DOMAIN.manifest, manifest);
}
