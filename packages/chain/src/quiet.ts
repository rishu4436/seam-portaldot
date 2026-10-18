/**
 * Keeps polkadot.js console noise out of SEAM output, without hiding anything real.
 *
 * 1. "multiple versions" (detectPackage): this package installs @seam/compiler with
 *    install-links=true, so normally only one copy of each @polkadot package is loaded. If a host app
 *    still ends up with two copies of the SAME version (e.g. a symlinked workspace), polkadot.js honours
 *    POLKADOTJS_DISABLE_ESM_CJS_WARNING=1 and stays quiet. It still warns when versions really differ.
 *    This module must be imported before any @polkadot module (index.ts imports it first).
 *
 * 2. "Unable to map [u8; 32] to a lookup index": printed when polkadot.js decorates storage for
 *    V13 metadata. Its substrate well-known keys (e.g. :changes_trie) want a [u8; 32] lookup type that
 *    V13-converted metadata does not contain. It only affects those well-known keys, which SEAM never
 *    reads. quietly() drops exactly that one message while fn runs; every other warning passes through.
 */
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
if (env && env.POLKADOTJS_DISABLE_ESM_CJS_WARNING === undefined) {
  env.POLKADOTJS_DISABLE_ESM_CJS_WARNING = "1";
}

const NOISE = /^Unable to map \[u8; 32\] to a lookup index$/;

export function quietly<T>(fn: () => T): T {
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    if (args.length === 1 && typeof args[0] === "string" && NOISE.test(args[0])) return;
    original.apply(console, args as []);
  };
  try {
    return fn();
  } finally {
    console.warn = original;
  }
}
