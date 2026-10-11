import type { Codec } from '@polkadot/types/types';
import { u8aToHex } from '@polkadot/util';
import type { Hex, RuntimeFacts } from '@seam/compiler';
import { decodeRuntime, describeDispatchError } from './runtime.js';

/** Event shape Bot 5's receipt verifies against: positional args, accounts as 0x AccountId32 hex, numbers as decimal strings. */
export interface ChainEvent { pallet: string; name: string; args: string[] }

export interface DecodedEvent extends ChainEvent {
  /** Position in the block's System.Events. */
  eventIndex: number;
  /** Extrinsic index for ApplyExtrinsic events, null for Initialization/Finalization. */
  extrinsicIndex: number | null;
  /** Runtime type name of each arg (metadata V13 has no field names). */
  argTypes: string[];
  topics: Hex[];
}

export interface ExtrinsicOutcome {
  events: DecodedEvent[];
  /** true on System.ExtrinsicSuccess, false on System.ExtrinsicFailed, undefined when neither is present. */
  success: boolean | undefined;
  /** Decoded dispatch error for a failed extrinsic, e.g. "assets.NoPermission: ...". */
  dispatchError?: string;
}

const ACCOUNT_TYPES = /^(T::)?(AccountId|AccountId32|LookupSource|Address)$/;

function isIntLike(c: unknown): c is { toBigInt(): bigint } {
  return typeof (c as { toBigInt?: unknown }).toBigInt === 'function' && typeof (c as { bitLength?: unknown }).bitLength === 'function';
}

/** One event arg as a string: accounts and byte arrays as 0x hex, integers as decimal strings, structs/enums as canonical JSON. */
export function argToString(c: Codec, typeName: string): string {
  if (ACCOUNT_TYPES.test(typeName) || c.toRawType() === 'AccountId') return u8aToHex(c.toU8a().slice(-32));
  const unwrapped = typeof (c as { unwrap?: unknown }).unwrap === 'function' && (c as { isNone?: unknown }).isNone === undefined
    ? (c as unknown as { unwrap(): Codec }).unwrap()
    : c;
  if (isIntLike(unwrapped)) return unwrapped.toBigInt().toString();
  if (unwrapped instanceof Uint8Array) return u8aToHex(unwrapped);
  const p = unwrapped.toPrimitive();
  if (typeof p === 'string' || typeof p === 'number' || typeof p === 'boolean') return String(p);
  return JSON.stringify(sortKeys(p));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}

/** Decodes a block's raw System.Events with the pinned runtime. Throws if any byte is left over. */
export function decodeBlockEvents(eventsHex: string, facts: RuntimeFacts): DecodedEvent[] {
  const { registry, metadata } = decodeRuntime(facts);
  const records = registry.createType('Vec<EventRecord>', eventsHex) as unknown as Array<{
    phase: { isApplyExtrinsic: boolean; asApplyExtrinsic: { toNumber(): number } };
    event: { index: Uint8Array; method: string; data: Codec[]; meta: { args: { toString(): string }[] } };
    topics: { toHex(): string }[];
  }> & Codec;
  if (records.encodedLength !== (eventsHex.length - 2) / 2) {
    throw new Error(`System.Events did not decode cleanly (${records.encodedLength} of ${(eventsHex.length - 2) / 2} bytes); the pinned types do not match this block`);
  }
  const palletNames = new Map(metadata.asLatest.pallets.map((p) => [p.index.toNumber(), p.name.toString()]));
  return records.map((r, eventIndex) => {
    const argTypes = r.event.meta.args.map((a) => a.toString());
    return {
      pallet: palletNames.get(r.event.index[0]!) ?? `pallet${r.event.index[0]}`,
      name: r.event.method,
      args: r.event.data.map((d, i) => argToString(d, argTypes[i] ?? '')),
      eventIndex,
      extrinsicIndex: r.phase.isApplyExtrinsic ? r.phase.asApplyExtrinsic.toNumber() : null,
      argTypes,
      topics: r.topics.map((t) => t.toHex() as Hex)
    };
  });
}

/** Events of one extrinsic plus success/failure. The dispatch error is decoded from the raw ExtrinsicFailed record. */
export function outcomeForExtrinsic(eventsHex: string, extrinsicIndex: number, facts: RuntimeFacts): ExtrinsicOutcome {
  const all = decodeBlockEvents(eventsHex, facts);
  const events = all.filter((e) => e.extrinsicIndex === extrinsicIndex);
  const failed = events.find((e) => e.pallet === 'System' && e.name === 'ExtrinsicFailed');
  const succeeded = events.some((e) => e.pallet === 'System' && e.name === 'ExtrinsicSuccess');
  const out: ExtrinsicOutcome = { events, success: failed ? false : succeeded ? true : undefined };
  if (failed) {
    const { registry } = decodeRuntime(facts);
    const records = registry.createType('Vec<EventRecord>', eventsHex) as unknown as { event: { data: Codec[] } }[];
    const errorCodec = records[failed.eventIndex]!.event.data[0]!;
    out.dispatchError = describeDispatchError(facts, errorCodec.toU8a());
  }
  return out;
}

/** Strips a decoded event down to the receipt's { pallet, name, args }. */
export const toChainEvent = (e: ChainEvent): ChainEvent => ({ pallet: e.pallet, name: e.name, args: [...e.args] });
