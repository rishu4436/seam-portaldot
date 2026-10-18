import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Hex } from '@seam/compiler';
import type { ReservableApprovalStore, ReservationRecord, ReservationState, ReserveResult } from '@seam/policy';

/** The store file could not be read, parsed or written. Every operation fails closed: nothing is ever treated as unused. */
export class ApprovalStoreError extends Error {
  constructor(message: string) { super(`approval store: ${message}`); this.name = 'ApprovalStoreError'; }
}

interface StoreFile { version: 1; records: Record<string, ReservationRecord>; released: { key: string; idempotencyKey: string; at: string }[] }
const STATES: ReservationState[] = ['reserved', 'committed', 'uncertain'];
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * A durable ReservableApprovalStore on one JSON file, same semantics as InMemoryApprovalStore.
 * - Every operation takes a lock file (O_EXCL, with stale-owner detection), re-reads the file, changes it, and writes
 *   it back atomically (temp file, fsync, rename, fsync of the directory). Instances in one process or in several
 *   processes never lose each other's updates.
 * - reserved, uncertain and committed records survive a restart and keep blocking reuse. uncertain also blocks release
 *   until reconcile().
 * - A missing file is an empty store. Anything else wrong with it (unparseable, wrong version, bad record, unreadable)
 *   throws ApprovalStoreError on every call and the file is never overwritten, so a damaged store can never
 *   look like "nothing was sent".
 * - release()/reconcile(not_broadcast) remove the key and append an entry to `released` (audit trail).
 * Synchronous on purpose: it implements the synchronous ApprovalStore interface.
 */
export class FileApprovalStore implements ReservableApprovalStore {
  readonly path: string;
  constructor(path: string, private opts: { lockTimeoutMs?: number } = {}) { this.path = resolve(path); }

  private read(): StoreFile {
    let text: string;
    try { text = readFileSync(this.path, 'utf8'); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, records: {}, released: [] };
      throw new ApprovalStoreError(`cannot read ${this.path} (${(e as Error).message}); refusing to treat anything as unused`);
    }
    let j: any;
    try { j = JSON.parse(text); } catch { throw new ApprovalStoreError(`${this.path} is not valid JSON (corrupt or truncated); refusing to treat anything as unused`); }
    if (!j || j.version !== 1 || typeof j.records !== 'object' || j.records === null || Array.isArray(j.records)) {
      throw new ApprovalStoreError(`${this.path} has an unknown format or version; refusing to treat anything as unused`);
    }
    for (const [k, r] of Object.entries<any>(j.records)) {
      if (!r || r.key !== k || !STATES.includes(r.state) || typeof r.idempotencyKey !== 'string' || typeof r.at !== 'string') {
        throw new ApprovalStoreError(`${this.path} has a damaged record for ${k}; refusing to treat anything as unused`);
      }
    }
    return { version: 1, records: j.records, released: Array.isArray(j.released) ? j.released : [] };
  }

  private write(data: StoreFile) {
    const tmp = `${this.path}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const fd = openSync(tmp, 'w', 0o600);
      try { writeSync(fd, JSON.stringify(data, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(tmp, this.path);
      try { const d = openSync(dirname(this.path), 'r'); try { fsyncSync(d); } finally { closeSync(d); } } catch { /* directory fsync is best effort */ }
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* none */ }
      throw new ApprovalStoreError(`cannot write ${this.path} (${(e as Error).message})`);
    }
  }

  private locked<T>(fn: () => T): T {
    const lock = `${this.path}.lock`;
    mkdirSync(dirname(this.path), { recursive: true });
    const deadline = Date.now() + (this.opts.lockTimeoutMs ?? 10_000);
    for (;;) {
      try {
        const fd = openSync(lock, 'wx', 0o600);
        writeSync(fd, String(process.pid)); closeSync(fd);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new ApprovalStoreError(`cannot lock ${this.path} (${(e as Error).message})`);
        if (this.staleLock(lock)) { try { unlinkSync(lock); } catch { /* raced */ } continue; }
        if (Date.now() > deadline) throw new ApprovalStoreError(`timed out waiting for the lock ${lock}`);
        sleepSync(5);
      }
    }
    try { return fn(); } finally { try { unlinkSync(lock); } catch { /* gone */ } }
  }

  private staleLock(lock: string): boolean {
    try {
      const pid = Number(readFileSync(lock, 'utf8'));
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
        try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') return true; }
      }
      return Date.now() - statSync(lock).mtimeMs > 60_000;
    } catch { return false; }
  }

  private tx<T>(fn: (d: StoreFile) => T): T { return this.locked(() => { const d = this.read(); const out = fn(d); this.write(d); return out; }); }
  private need(d: StoreFile, key: string, op: string, allowed: ReservationState[]): ReservationRecord {
    const r = d.records[key];
    if (!r) throw new Error(`${op}: ${key} has no reservation`);
    if (!allowed.includes(r.state)) throw new Error(`${op}: ${key} is ${r.state}${r.state === 'uncertain' ? ' and must be reconciled first' : ''}`);
    return r;
  }

  has(key: string): boolean { return this.locked(() => key in this.read().records); }
  stateOf(key: string): ReservationRecord | undefined { return this.locked(() => { const r = this.read().records[key]; return r ? { ...r } : undefined; }); }

  markUsed(key: string): void {
    this.tx((d) => { const prev = d.records[key]; d.records[key] = { key, state: 'committed', idempotencyKey: prev?.idempotencyKey ?? key, ...(prev?.txHash ? { txHash: prev.txHash } : {}), at: new Date().toISOString() }; });
  }

  reserve(key: string, opts: { idempotencyKey: string; now?: Date }): ReserveResult {
    return this.locked(() => {
      const d = this.read();
      const existing = d.records[key];
      if (existing) return { ok: false as const, reason: existing.state, record: { ...existing }, ...(existing.txHash ? { txHash: existing.txHash } : {}) };
      const record: ReservationRecord = { key, state: 'reserved', idempotencyKey: opts.idempotencyKey, at: (opts.now ?? new Date()).toISOString() };
      d.records[key] = record;
      this.write(d);
      return { ok: true as const, record: { ...record } };
    });
  }

  commit(key: string, opts: { txHash: Hex }): void { this.tx((d) => { const r = this.need(d, key, 'commit', ['reserved', 'uncertain']); r.state = 'committed'; r.txHash = opts.txHash; }); }

  release(key: string): void {
    this.tx((d) => { const r = this.need(d, key, 'release', ['reserved']); d.released.push({ key, idempotencyKey: r.idempotencyKey, at: new Date().toISOString() }); delete d.records[key]; });
  }

  markUncertain(key: string, opts: { txHash?: Hex; note?: string }): void {
    this.tx((d) => { const r = this.need(d, key, 'markUncertain', ['reserved', 'uncertain']); r.state = 'uncertain'; if (opts.txHash) r.txHash = opts.txHash; if (opts.note) r.note = opts.note; });
  }

  reconcile(key: string, opts: { outcome: 'broadcast'; txHash: Hex } | { outcome: 'not_broadcast' }): void {
    this.tx((d) => {
      const r = this.need(d, key, 'reconcile', ['uncertain']);
      if (opts.outcome === 'broadcast') { r.state = 'committed'; r.txHash = opts.txHash; }
      else { d.released.push({ key, idempotencyKey: r.idempotencyKey, at: new Date().toISOString() }); delete d.records[key]; }
    });
  }
}
