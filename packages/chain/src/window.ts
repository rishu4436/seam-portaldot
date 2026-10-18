import { rpc, toSafeNumber, withClient, type ConnectOptions, type Endpoint } from './rpc.js';
import type { SigningRequest } from './signing.js';

/**
 * SEAM-016: is the approved request's signing window still valid right now? Read-only.
 * Reasons (all mean: do not send):
 *   era_expired              the chain's best block is at or past checkpoint + era period
 *   nonce_stale              the account's next nonce on chain is already past the request's nonce
 *   nonce_not_next           the account's next nonce is behind the request's (an earlier transaction has not landed)
 *   checkpoint_not_on_chain  the block the wallet signed against is no longer the block at that height
 *   window_unreadable        the node could not answer, so nothing is assumed
 */
export type WindowReason = 'era_expired' | 'nonce_stale' | 'nonce_not_next' | 'checkpoint_not_on_chain' | 'window_unreadable';
export interface WindowCheck { ok: boolean; reasons: WindowReason[]; detail: string[] }

export async function checkSigningWindow(endpoint: Endpoint, request: SigningRequest, opts: ConnectOptions = {}): Promise<WindowCheck> {
  const reasons: WindowReason[] = [];
  const detail: string[] = [];
  try {
    await withClient(endpoint, async (client) => {
      const birth = Number.parseInt(String(request.payload.blockNumber), 16);
      const bestHash = await rpc<string>(client, 'chain_getBlockHash', []);
      const bestHeader = await rpc<{ number: unknown } | null>(client, 'chain_getHeader', [bestHash]);
      if (!bestHeader) throw new Error('no header for the best block');
      const best = toSafeNumber(bestHeader.number);
      if (request.era.mortal && Number.isSafeInteger(birth) && best >= birth + request.era.period) {
        reasons.push('era_expired'); detail.push(`best block #${best} is at or past checkpoint #${birth} + period ${request.era.period}`);
      }
      const next = toSafeNumber(await rpc<unknown>(client, 'system_accountNextIndex', [request.payload.address]));
      if (next > request.nonce) { reasons.push('nonce_stale'); detail.push(`chain next nonce ${next} is past the request's ${request.nonce}`); }
      else if (next < request.nonce) { reasons.push('nonce_not_next'); detail.push(`chain next nonce ${next} is behind the request's ${request.nonce}`); }
      const at = await rpc<string | null>(client, 'chain_getBlockHash', [birth]);
      if (!at || at.toLowerCase() !== String(request.payload.blockHash).toLowerCase()) {
        reasons.push('checkpoint_not_on_chain'); detail.push(`block #${birth} is ${at ?? 'unknown'}, not the signed checkpoint`);
      }
    }, opts);
  } catch (e) {
    return { ok: false, reasons: ['window_unreadable'], detail: [(e as Error).message] };
  }
  return { ok: reasons.length === 0, reasons, detail };
}
