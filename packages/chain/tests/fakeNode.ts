import { hexToU8a, u8aConcat, u8aToHex } from '@polkadot/util';
import { blake2AsHex, signatureVerify } from '@polkadot/util-crypto';
import type { Hex, RuntimeFacts } from '@seam/compiler';
import { SYSTEM_EVENTS_KEY, decodeRuntime, encodeRuntime, storageKey, type ChainInputs, type RpcClient } from '../src/index.js';

/**
 * In-process stand-in for a Portaldot node, serving the real mainnet snapshot. It answers the RPCs SEAM
 * uses, checks signatures like a node would, and "includes" submitted extrinsics in fake blocks with
 * plausible events. Nothing leaves the process.
 */
export interface FakeNodeOptions {
  inputs: ChainInputs;
  facts: RuntimeFacts;
  /** Asset ids that exist (Assets.Asset storage present). */
  existingAssets?: string[];
  /** Response for contracts_call. Default: Ok, flags 0. */
  contractsCall?: unknown;
  /** Make an extrinsic fail with this DispatchError (by call index). */
  failCall?: (callHex: string) => { index: number; error: number } | undefined;
  /** Stop the watch after in_block (to test timeouts). */
  stopAfterInBlock?: boolean;
  /** Report this status instead of including (e.g. 'invalid', 'dropped'). */
  rejectWith?: string;
  /** payment_queryInfo weight JSON. Default: the plain number spec 1002 returns (Weight V1). */
  queryInfoWeight?: unknown;
  /** author_pendingExtrinsics (the pool). */
  pending?: string[];
  /** Finalized head = best head minus this many blocks. */
  finalizedLag?: number;
  /** state_getMetadata at any block other than the snapshot head returns this (same spec version, different metadata). */
  metadataAtBlocks?: Hex;
  /** These RPC methods throw (simulates an unreachable / broken node). */
  failRpc?: string[];
  /** Chain advances by this many empty blocks via advance(). */
}

interface FakeBlock { number: number; hash: Hex; extrinsics: string[]; events: Hex }

export class FakeNode implements RpcClient {
  readonly log: { method: string; params: unknown[] }[] = [];
  readonly submitted: string[] = [];
  private blocks = new Map<string, FakeBlock>();
  private byNumber = new Map<number, Hex>();
  private head: { number: number; hash: Hex };
  private nonces = new Map<string, number>();
  private subs = new Map<number, (e: Error | null, r: unknown) => void>();
  private nextSub = 1;

  constructor(private o: FakeNodeOptions) {
    this.head = { ...o.inputs.head };
    this.byNumber.set(this.head.number, this.head.hash);
  }

  /** Adds `count` empty blocks (time passing). */
  advance(count: number) {
    for (let i = 0; i < count; i++) {
      const number = this.head.number + 1;
      const hash = blake2AsHex(`fake-block-${number}`, 256) as Hex;
      this.blocks.set(hash, { number, hash, extrinsics: [], events: '0x00' as Hex });
      this.byNumber.set(number, hash);
      this.head = { number, hash };
    }
  }

  /** Blocks older than the snapshot head: empty synthetic blocks (the real chain has them; we have no bodies). */
  private history(number: number): Hex | null {
    if (!(number >= 0 && number < this.o.inputs.head.number)) return null;
    const hash = blake2AsHex(`fake-old-block-${number}`, 256) as Hex;
    this.blocks.set(hash, { number, hash, extrinsics: [], events: '0x00' as Hex });
    this.byNumber.set(number, hash);
    return hash;
  }

  /** Sets the next nonce the node reports for an account (SS58). */
  setNonce(account: string, nonce: number) { this.nonces.set(account, nonce); }
  /** The block at `number` is replaced by a different one (a reorg of the checkpoint). */
  forkAt(number: number) { this.byNumber.set(number, blake2AsHex(`forked-${number}`, 256) as Hex); }

  /** From now on these RPC methods throw. */
  breakRpc(...methods: string[]) { this.o.failRpc = [...(this.o.failRpc ?? []), ...methods]; }

  private header(hash: string) {
    const lc = hash.toLowerCase();
    if (lc === this.o.inputs.head.hash) return { number: `0x${this.o.inputs.head.number.toString(16)}`, parentHash: '0x' + '00'.repeat(32) };
    const b = this.blocks.get(lc);
    return b ? { number: `0x${b.number.toString(16)}`, parentHash: '0x' + '00'.repeat(32) } : null;
  }

  private assetKey(id: string): string {
    return storageKey((decodeRuntime(this.o.facts).decorated().query as any).assets.asset, id);
  }

  async send<T>(method: string, params: unknown[]): Promise<T> {
    this.log.push({ method, params });
    const r = (v: unknown) => v as T;
    if (this.o.failRpc?.includes(method)) throw new Error(`FakeNode: ${method} unreachable`);
    switch (method) {
      case 'chain_getBlockHash':
        if (params.length === 0) return r(this.head.hash);
        if (params[0] === 0) return r(this.o.inputs.genesisHash);
        return r(this.byNumber.get(params[0] as number) ?? this.history(params[0] as number));
      case 'chain_getFinalizedHead':
        return r(this.byNumber.get(this.head.number - (this.o.finalizedLag ?? 0)) ?? this.head.hash);
      case 'author_pendingExtrinsics':
        return r(this.o.pending ?? []);
      case 'chain_getHeader':
        return r(this.header(String(params[0] ?? this.head.hash)));
      case 'chain_getBlock': {
        const b = this.blocks.get(String(params[0]).toLowerCase());
        if (!b && String(params[0]).toLowerCase() === this.o.inputs.head.hash) return r({ block: { header: this.header(this.o.inputs.head.hash), extrinsics: [] } });
        return r(b ? { block: { header: this.header(b.hash), extrinsics: b.extrinsics } } : null);
      }
      case 'state_getMetadata':
        if (this.o.metadataAtBlocks && params[0] && String(params[0]).toLowerCase() !== this.o.inputs.head.hash) return r(this.o.metadataAtBlocks);
        return r(this.o.inputs.metadataHex);
      case 'state_getRuntimeVersion':
        return r(this.o.inputs.runtimeVersion);
      case 'system_properties':
        return r(this.o.inputs.properties);
      case 'rpc_methods':
        return r({ methods: ['author_submitAndWatchExtrinsic', 'chain_subscribeFinalizedHeads', 'contracts_call', 'payment_queryInfo', 'system_accountNextIndex', 'system_dryRun'] });
      case 'system_accountNextIndex':
        return r(this.nonces.get(String(params[0])) ?? 0);
      case 'payment_queryInfo':
        return r({ weight: this.o.queryInfoWeight ?? 200000000, class: 'normal', partialFee: '1500000000' });
      case 'payment_queryFeeDetails':
        throw new Error('Method not found');
      case 'system_dryRun':
        return r(this.dryRun(String(params[0])));
      case 'contracts_call':
        return r(this.o.contractsCall ?? { debugMessage: '', gasConsumed: 1000, result: { Ok: { flags: 0, data: '0x' } } });
      case 'state_getStorage': {
        const [key, at] = params as [string, string | undefined];
        if (key === SYSTEM_EVENTS_KEY) return r(at ? this.blocks.get(at.toLowerCase())?.events ?? null : null);
        for (const id of this.o.existingAssets ?? []) if (key === this.assetKey(id)) return r('0x00');
        return r(null);
      }
      default:
        throw new Error(`FakeNode: unsupported ${method}`);
    }
  }

  async subscribe(_type: string, method: string, params: unknown[], cb: (e: Error | null, r: unknown) => void): Promise<number> {
    this.log.push({ method, params });
    const id = this.nextSub++;
    this.subs.set(id, cb);
    if (method === 'chain_subscribeFinalizedHeads') {
      setTimeout(() => this.subs.get(id)?.(null, this.header(this.head.hash)), 0);
      return id;
    }
    if (method !== 'author_submitAndWatchExtrinsic') throw new Error(`FakeNode: unsupported subscription ${method}`);
    const hex = String(params[0]);
    const block = this.include(hex); // throws like a node on a bad signature / stale nonce
    this.submitted.push(hex);
    const emit = (v: unknown, delay: number) => setTimeout(() => this.subs.get(id)?.(null, v), delay);
    if (this.o.rejectWith) {
      emit('ready', 1);
      emit(this.o.rejectWith, 2);
      return id;
    }
    emit('ready', 1);
    emit({ inBlock: block.hash }, 2);
    if (!this.o.stopAfterInBlock) emit({ finalized: block.hash }, 3);
    return id;
  }

  async unsubscribe(_type: string, _method: string, id: number | string): Promise<boolean> {
    return this.subs.delete(Number(id));
  }

  /** ApplyExtrinsicResult like a node: Future/Stale nonce, BadProof, or Ok(Err(Module)) from failCall. */
  private dryRun(hex: string): Hex {
    const { registry } = encodeRuntime(this.o.facts);
    const ext = registry.createType('Extrinsic', hex);
    const expected = this.nonces.get(ext.signer.toString()) ?? 0;
    if (ext.nonce.toNumber() > expected) return '0x010002';
    if (ext.nonce.toNumber() < expected) return '0x010003';
    if (!this.signatureOk(ext)) return '0x010004';
    const fail = this.o.failCall?.(ext.method.toHex());
    if (fail) return `0x000103${fail.index.toString(16).padStart(2, '0')}${fail.error.toString(16).padStart(2, '0')}` as Hex;
    return '0x0000';
  }

  private signatureOk(ext: any): boolean {
    const { registry } = encodeRuntime(this.o.facts);
    const fp = this.o.facts.fingerprint;
    const payload = registry.createType('ExtrinsicPayload', {
      method: ext.method.toHex(), era: ext.era.toHex(), nonce: ext.nonce, tip: ext.tip,
      specVersion: fp.specVersion, transactionVersion: fp.transactionVersion, genesisHash: fp.genesisHash,
      blockHash: this.o.inputs.head.hash
    }, { version: 4 }).toU8a({ method: true });
    const multi = ext.inner.signature.multiSignature.toU8a();
    return signatureVerify(payload.length > 256 ? hexToU8a(blake2AsHex(payload, 256)) : payload, multi, ext.signer.toString()).isValid;
  }

  /** Verifies the extrinsic like a node, then puts it in a new block with events. */
  private include(hex: string): FakeBlock {
    const { registry } = encodeRuntime(this.o.facts);
    const ext = registry.createType('Extrinsic', hex);
    if (!ext.isSigned) throw new Error('1010: Invalid Transaction: unsigned');
    const signer = ext.signer.toString();
    const expectedNonce = this.nonces.get(signer) ?? 0;
    if (ext.nonce.toNumber() !== expectedNonce) throw new Error(`1010: Invalid Transaction: nonce ${ext.nonce.toNumber()} != ${expectedNonce}`);
    if (!this.signatureOk(ext)) {
      throw new Error('1010: Invalid Transaction: Transaction has a bad signature');
    }
    this.nonces.set(signer, expectedNonce + 1);

    const number = this.head.number + 1;
    const hash = blake2AsHex(`fake-block-${number}`, 256) as Hex;
    const records = this.eventsFor(ext.method.toHex(), u8aToHex(ext.signer.toU8a().slice(-32)));
    const block: FakeBlock = { number, hash, extrinsics: ['0x280403000b00a08429a101', hex], events: records };
    this.blocks.set(hash, block);
    this.byNumber.set(number, hash);
    this.head = { number, hash };
    return block;
  }

  private eventsFor(callHex: string, signerHex: string): Hex {
    const { registry, metadata } = decodeRuntime(this.o.facts);
    const enc = (type: string, v: unknown) => registry.createType(type as never, v as never).toU8a();
    const index = (pallet: string, name: string) => {
      const p = metadata.asLatest.pallets.find((x) => x.name.toString() === pallet)!;
      const v = registry.lookup.getSiType(p.events.unwrap().type).def.asVariant.variants.find((x) => x.name.toString() === name)!;
      return new Uint8Array([p.index.toNumber(), v.index.toNumber()]);
    };
    const record = (pallet: string, name: string, args: Uint8Array[]) =>
      u8aConcat(new Uint8Array([0]), enc('u32', 1), index(pallet, name), ...args, new Uint8Array([0]));
    const info = enc('DispatchInfo', { weight: 200000000, class: 'Normal', paysFee: 'Yes' });
    const out: Uint8Array[] = [];
    const fail = this.o.failCall?.(callHex);
    if (fail) {
      out.push(record('System', 'ExtrinsicFailed', [enc('DispatchError', { Module: fail }), info]));
    } else {
      const calls = [registry.createType('Call', callHex)];
      if (calls[0]!.section === 'utility') calls.splice(0, 1, ...(calls[0]!.args[0] as any).map((c: any) => registry.createType('Call', c.toHex())));
      for (const c of calls) {
        const a = c.args as any[];
        if (c.section === 'assets' && c.method === 'transferKeepAlive') out.push(record('Assets', 'Transferred', [enc('AssetId', a[0]), hexToU8a(signerHex), a[1].value.toU8a(), enc('TAssetBalance', a[2])]));
        if (c.section === 'assets' && c.method === 'mint') out.push(record('Assets', 'Issued', [enc('AssetId', a[0]), a[1].value.toU8a(), enc('TAssetBalance', a[2])]));
        if (c.section === 'contracts' && c.method === 'call') out.push(record('Contracts', 'ContractEmitted', [a[0].value.toU8a(), enc('Bytes', '0x01')]));
      }
      out.push(record('System', 'ExtrinsicSuccess', [info]));
    }
    return u8aToHex(u8aConcat(registry.createType('Compact<u32>', out.length).toU8a(), ...out)) as Hex;
  }
}
