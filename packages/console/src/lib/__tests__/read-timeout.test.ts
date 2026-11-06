import { afterEach, expect, it, vi } from "vitest";
import { withReadTimeout } from "../read-timeout";
afterEach(() => vi.useRealTimers());
it("releases a hung read with actionable recovery guidance and handles its late completion", async () => {
  vi.useFakeTimers();
  let finish!: (value: string) => void;
  const work = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const result = expect(withReadTimeout(work, 50)).rejects.toThrow(
    /Retry the read; do not resubmit/,
  );
  await vi.advanceTimersByTimeAsync(50);
  await result;
  finish("late");
  await work;
  expect(vi.getTimerCount()).toBe(0);
});
it("preserves the original read failure and clears its deadline", async () => {
  vi.useFakeTimers();
  await expect(withReadTimeout(Promise.reject(new Error("RPC unavailable")), 50)).rejects.toThrow(
    "RPC unavailable",
  );
  expect(vi.getTimerCount()).toBe(0);
});
