import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { factsFromMetadata, readPinnedTypes, type RuntimeFacts } from '@seam/compiler';

export interface SnapshotOptions {
  /** Snapshot name, e.g. "portaldot-mainnet" for portaldot-mainnet-snapshot.json. Needed only when a folder holds several. */
  name?: string;
  /** Pinned type definitions. Default: the compiler's default. */
  typesBundle?: string;
}

/** Finds `<name>-snapshot.json` and `<name>-metadata.hex`, given a folder, a snapshot file, or a folder plus a name. */
export function locateSnapshot(path: string, name?: string): { snapshotFile: string; metadataFile: string; name: string } {
  let dir = path;
  let n = name;
  if (!statSync(path).isDirectory()) {
    dir = dirname(path);
    n = basename(path).replace(/-snapshot\.json$/, '');
  }
  if (!n) {
    const found = readdirSync(dir).filter((f) => f.endsWith('-snapshot.json')).map((f) => f.replace(/-snapshot\.json$/, ''));
    if (found.length !== 1) {
      throw new Error(found.length ? `${dir} holds several snapshots (${found.join(', ')}); pick one with --name` : `no *-snapshot.json in ${dir}`);
    }
    n = found[0]!;
  }
  return { snapshotFile: join(dir, `${n}-snapshot.json`), metadataFile: join(dir, `${n}-metadata.hex`), name: n };
}

/**
 * Runtime facts from a saved node snapshot, so compile and policy work offline. Works with any snapshot written by
 * @seam/chain's snapshotFromNode (Portaldot mainnet, the test chain, later the V3 testnet). A token symbol or
 * decimals the node didn't report must be declared in the snapshot (`declaredToken`); SEAM never guesses them.
 */
export function factsFromSnapshot(path: string, opts: SnapshotOptions = {}): RuntimeFacts {
  const { snapshotFile, metadataFile } = locateSnapshot(path, opts.name);
  const snap = JSON.parse(readFileSync(snapshotFile, 'utf8'));
  const metadataHex = readFileSync(metadataFile, 'utf8').trim();
  const props = snap.properties ?? {};
  const pick = (v: unknown) => (Array.isArray(v) ? v[0] : v);
  const tokenSymbol = pick(props.tokenSymbol) ?? snap.declaredToken?.tokenSymbol;
  const tokenDecimals = pick(props.tokenDecimals) ?? snap.declaredToken?.tokenDecimals;
  if (tokenSymbol === undefined || tokenDecimals === undefined) {
    throw new Error(`${snapshotFile} has no token symbol or decimals, and none were declared`);
  }
  return factsFromMetadata({
    metadataHex, typesBundle: opts.typesBundle ?? readPinnedTypes(), genesisHash: snap.genesis,
    tokenSymbol, tokenDecimals,
    specName: snap.runtime?.specName, specVersion: snap.runtime?.specVersion, transactionVersion: snap.runtime?.transactionVersion,
    ss58Prefix: props.ss58Format ?? undefined, endpoint: snap.endpoint, blockNumber: snap.block,
  });
}
