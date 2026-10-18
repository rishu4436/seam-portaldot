import type { Capability, Plan, RuntimeFacts, RuntimeFingerprint } from '@seam/compiler';

export interface FingerprintChange { field: keyof RuntimeFingerprint; a: unknown; b: unknown }
export interface CapabilityChange {
  call: string;
  change: 'added' | 'removed' | 'status' | 'index' | 'args';
  a?: unknown;
  b?: unknown;
}
export interface DriftReport {
  drifted: boolean;
  fingerprint: FingerprintChange[];
  capabilities: CapabilityChange[];
  /** Present when a plan was given: stale = it was prepared for a different runtime than B. */
  plan?: { stale: boolean; planFingerprint: string; against: string };
  /** Facts the fingerprint does not cover but that differ. Informational. */
  other: { field: string; a: unknown; b: unknown }[];
}

const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
const idx = (c: Capability) => [c.palletIndex, c.callIndex];

/**
 * Compares two recorded runtimes (snapshots or discovered facts), read-only and offline. Reports every changed
 * fingerprint field and every call that was added, removed, or changed status, index or argument shape.
 * With `plan`, also says whether that plan was prepared for a different runtime than B (it would be blocked at the send gate).
 */
export function diffRuntimes(a: RuntimeFacts, b: RuntimeFacts, opts: { plan?: Plan } = {}): DriftReport {
  const fingerprint: FingerprintChange[] = [];
  for (const k of Object.keys({ ...a.fingerprint, ...b.fingerprint }) as (keyof RuntimeFingerprint)[]) {
    if (!same(a.fingerprint[k], b.fingerprint[k])) fingerprint.push({ field: k, a: a.fingerprint[k], b: b.fingerprint[k] });
  }
  const capabilities: CapabilityChange[] = [];
  for (const call of [...new Set([...Object.keys(a.capabilities), ...Object.keys(b.capabilities)])].sort()) {
    const x = a.capabilities[call], y = b.capabilities[call];
    if (x && !y) capabilities.push({ call, change: 'removed', a: x.status });
    else if (!x && y) capabilities.push({ call, change: 'added', b: y.status });
    else if (x && y) {
      if (x.status !== y.status) capabilities.push({ call, change: 'status', a: x.status, b: y.status });
      else if (!same(idx(x), idx(y))) capabilities.push({ call, change: 'index', a: idx(x), b: idx(y) });
      else if (!same(x.args, y.args)) capabilities.push({ call, change: 'args', a: x.args, b: y.args });
    }
  }
  const other: DriftReport['other'] = [];
  for (const f of ['stateVersion', 'metadataVersion', 'signingAccountBytes'] as const) {
    if (!same(a[f], b[f])) other.push({ field: f, a: a[f], b: b[f] });
  }
  const report: DriftReport = { drifted: fingerprint.length > 0 || capabilities.length > 0, fingerprint, capabilities, other };
  if (opts.plan) report.plan = { stale: opts.plan.fingerprintDigest !== b.fingerprintDigest, planFingerprint: opts.plan.fingerprintDigest, against: b.fingerprintDigest };
  return report;
}

const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));

/** Plain-English drift report. Fixed wording. */
export function explainDrift(d: DriftReport, limit = 40): string {
  const lines = [`Runtime drift: ${d.drifted ? 'yes' : 'no'}. This compares two recorded runtimes (snapshots), not a live check, and is not monitoring.`];
  for (const f of d.fingerprint) lines.push(`- ${f.field}: ${show(f.a)} -> ${show(f.b)}`);
  const verb = { added: 'only in B', removed: 'only in A', status: 'status changed', index: 'call index changed', args: 'argument shape changed' } as const;
  for (const c of d.capabilities.slice(0, limit)) {
    lines.push(`- ${c.call}: ${verb[c.change]}${c.change === 'added' ? ` (${show(c.b)})` : c.change === 'removed' ? ` (${show(c.a)})` : ` (${show(c.a)} -> ${show(c.b)})`}`);
  }
  if (d.capabilities.length > limit) lines.push(`- ...and ${d.capabilities.length - limit} more changed calls (use --json for all).`);
  for (const o of d.other) lines.push(`- (not in the fingerprint) ${o.field}: ${show(o.a)} -> ${show(o.b)}`);
  if (d.plan) lines.push(d.plan.stale ? 'The plan was prepared for a different runtime than B: it is stale and would be blocked at the send gate (runtime_changed).' : 'The plan was prepared for this runtime (B): not stale.');
  return lines.join('\n');
}
