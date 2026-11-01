/** Hosted Portaldot V3 testnet. The console signs and submits only here. */
export const HOSTED_V3_GENESIS =
  "0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd";
export const HOSTED_V3_SPEC = "portaldot-v3";

/** Portaldot mainnet (spec 1002 snapshot). Submit is refused. */
export const PORTALDOT_MAINNET_GENESIS =
  "0x83b5212c69f85f3996f8696bb35bf913af51b176a5f53d0a74fd3a83dc0b8a54";

export interface ChainIdentity {
  genesisHash?: string;
  specName?: string;
}

/**
 * Empty when this chain is the hosted V3 testnet. Otherwise a sentence that must block
 * signing and submit. An unreadable identity blocks too.
 */
export function hostedTestnetProblem(id: ChainIdentity | undefined): string | undefined {
  const genesis = id?.genesisHash?.toLowerCase();
  const spec = id?.specName;
  if (!genesis || !spec)
    return "The chain identity could not be read, so nothing will be signed or sent.";
  if (genesis === PORTALDOT_MAINNET_GENESIS || spec === "portaldot")
    return "This node is Portaldot mainnet. SEAM will not sign or send here.";
  if (genesis !== HOSTED_V3_GENESIS || spec !== HOSTED_V3_SPEC)
    return `This node is ${spec}, not the hosted V3 testnet (${HOSTED_V3_SPEC}). Nothing will be signed or sent.`;
  return undefined;
}
