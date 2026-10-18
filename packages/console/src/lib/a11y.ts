// Pure keyboard helpers (testable without a DOM).
/** Roving-focus index for a radiogroup: arrows wrap, Home/End jump. Returns undefined for other keys. */
export function radioNext(key: string, index: number, count: number): number | undefined {
  if (count <= 0) return undefined;
  if (key === "ArrowDown" || key === "ArrowRight") return (index + 1) % count;
  if (key === "ArrowUp" || key === "ArrowLeft") return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return undefined;
}
export const isEscape = (key: string) => key === "Escape" || key === "Esc";
