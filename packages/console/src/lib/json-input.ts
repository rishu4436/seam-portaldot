/** Do not expose engine-specific parser positions or file contents to users. */
export function parseJsonFile(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw Error(
      "This file is not valid JSON. Export the original archive again and choose the unmodified .json file.",
    );
  }
}
