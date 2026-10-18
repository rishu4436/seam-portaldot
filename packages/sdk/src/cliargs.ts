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
