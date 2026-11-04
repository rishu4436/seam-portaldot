// Browser feature test double with real mutual exclusion, installed only by Vitest.
// Production uses navigator.locks supplied by the browser and fails closed without it.
const queues = new Map<string, Promise<void>>();
if (typeof navigator !== "undefined" && !navigator.locks) {
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      async request<T>(
        name: string,
        optionsOrCallback: { ifAvailable?: boolean } | ((lock: object | null) => T | Promise<T>),
        suppliedCallback?: (lock: object | null) => T | Promise<T>,
      ): Promise<T> {
        const callback =
          typeof optionsOrCallback === "function" ? optionsOrCallback : suppliedCallback!;
        if (
          typeof optionsOrCallback !== "function" &&
          optionsOrCallback.ifAvailable &&
          queues.has(name)
        )
          return callback(null);
        const previous = queues.get(name) ?? Promise.resolve();
        let release!: () => void;
        const next = new Promise<void>((resolve) => {
          release = resolve;
        });
        queues.set(name, next);
        await previous;
        try {
          return await callback({ name });
        } finally {
          release();
          if (queues.get(name) === next) queues.delete(name);
        }
      },
    },
  });
}
