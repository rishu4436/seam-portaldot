import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Node only: reads the pinned types file from disk. Kept out of runtime.ts so the pure facts path has no node builtins.
export const PORTALDOT_SPEC1002_TYPES_PATH = fileURLToPath(
  new URL("../types/portaldot-spec1002.json", import.meta.url),
);

/** Reads a pinned types file as exact text (its bytes are hashed into the fingerprint). */
export function readPinnedTypes(path: string = PORTALDOT_SPEC1002_TYPES_PATH): string {
  return readFileSync(path, "utf8");
}
