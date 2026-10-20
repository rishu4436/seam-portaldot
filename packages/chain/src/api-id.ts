import { u8aToHex } from "@polkadot/util";
import { blake2AsU8a } from "@polkadot/util-crypto";

/** blake2b-64 of the API name: how a runtime lists its APIs in state_getRuntimeVersion. */
export function runtimeApiId(name: string): string {
  return u8aToHex(blake2AsU8a(name, 64));
}
