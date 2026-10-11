import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { factsFromMetadata, readPinnedTypes, type RuntimeFacts } from '@seam/compiler';

/** Runtime facts from a saved node snapshot (metadata hex + snapshot json), so compile and policy work offline. */
export function factsFromSnapshot(dir: string): RuntimeFacts {
  const snap = JSON.parse(readFileSync(join(dir, 'portaldot-mainnet-snapshot.json'), 'utf8'));
  const metadataHex = readFileSync(join(dir, 'portaldot-mainnet-metadata.hex'), 'utf8').trim();
  return factsFromMetadata({
    metadataHex, typesBundle: readPinnedTypes(), genesisHash: snap.genesis,
    tokenSymbol: snap.properties.tokenSymbol, tokenDecimals: snap.properties.tokenDecimals,
    specName: snap.runtime.specName, specVersion: snap.runtime.specVersion, transactionVersion: snap.runtime.transactionVersion,
    ss58Prefix: snap.properties.ss58Format, endpoint: snap.endpoint, blockNumber: snap.block,
  });
}
