import type { RuntimeFingerprint } from "@seam/compiler";
/** Parses `--token SYMBOL:DECIMALS` into the chain layer's `declaredToken`. Throws a usage error on a bad format. */
export function parseTokenFlag(
  v: string | undefined,
): { tokenSymbol: string; tokenDecimals: number } | undefined {
  if (v === undefined) return undefined;
  const m = /^([A-Za-z0-9_.-]{1,16}):(\d{1,2})$/.exec(v);
  if (!m || Number(m[2]) > 36)
    throw new Error(`--token needs SYMBOL:DECIMALS, like --token UNIT:12 (got "${v}")`);
  return { tokenSymbol: m[1]!, tokenDecimals: Number(m[2]) };
}

/** Parses repeated `--abi NAME=<file>` into the compiler's `abis` map, reading each file with `load`. */
export function parseAbiFlags(
  values: string[],
  load: (file: string) => unknown,
): Record<string, unknown> | undefined {
  if (!values.length) return undefined;
  const abis: Record<string, unknown> = {};
  for (const v of values) {
    const i = v.indexOf("=");
    if (i <= 0 || i === v.length - 1)
      throw new Error(`--abi needs NAME=<file>, like --abi erc20=./erc20.json (got "${v}")`);
    const name = v.slice(0, i),
      file = v.slice(i + 1);
    if (Object.prototype.hasOwnProperty.call(abis, name))
      throw new Error(`--abi name "${name}" is given twice`);
    try {
      abis[name] = load(file);
    } catch (e) {
      throw new Error(`--abi ${name}: cannot read ${file}: ${(e as Error).message}`);
    }
  }
  return abis;
}

const FP_KEYS = ["genesisHash", "specName", "specVersion", "transactionVersion", "metadataHash"];
const isFingerprint = (v: unknown): v is RuntimeFingerprint =>
  !!v &&
  typeof v === "object" &&
  FP_KEYS.every((k) => (v as Record<string, unknown>)[k] !== undefined);

/**
 * Parses `--runtime <file>` for `seam verify --endpoint`: a recorded run (its `.fingerprint`, as in
 * evidence/testnet-v3/runs/plan-*.json) or a bare RuntimeFingerprint JSON. Throws a clear usage error otherwise.
 */
export function parseRuntimeFlag(
  file: string | undefined,
  load: (file: string) => unknown,
): RuntimeFingerprint | undefined {
  if (file === undefined) return undefined;
  if (!file || file.startsWith("--"))
    throw new Error("--runtime needs a file: a run record or a RuntimeFingerprint JSON");
  let d: unknown;
  try {
    d = load(file);
  } catch (e) {
    throw new Error(`--runtime: cannot read ${file}: ${(e as Error).message}`);
  }
  const fp = isFingerprint((d as { fingerprint?: unknown })?.fingerprint)
    ? (d as { fingerprint: RuntimeFingerprint }).fingerprint
    : isFingerprint(d)
      ? d
      : undefined;
  if (!fp)
    throw new Error(
      `--runtime: ${file} is neither a run record with a "fingerprint" nor a RuntimeFingerprint (needs ${FP_KEYS.join(", ")})`,
    );
  return fp;
}
