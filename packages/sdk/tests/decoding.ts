import type { Hex } from "@seam/compiler";
import type { DecodedSignedExtrinsic } from "@seam/policy";

/**
 * Test fakes have no real extrinsics: a "signed transaction" is its call bytes, so decoding is the identity.
 * (A real adapter decodes the extrinsic; see packages/chain/tests/signed-binding.test.ts.)
 */
export const identityDecoding = (signer: string) => ({
  verifySigned: (txs: Hex[], calls: Hex[]) => {
    const reasons: string[] = [];
    if (txs.length !== calls.length) reasons.push("count_mismatch");
    calls.forEach((c, i) => {
      if (txs[i] !== undefined && txs[i]!.toLowerCase() !== c.toLowerCase())
        reasons.push(`step_${i}:call_mismatch`);
    });
    return { ok: reasons.length === 0, signedCalls: txs, reasons };
  },
  signedDecoder:
    () =>
    (xt: Hex): DecodedSignedExtrinsic | null => ({ call: xt, signer, signatureValid: true }),
});
