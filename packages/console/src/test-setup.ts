// Browser feature test double with real mutual exclusion, installed only by Vitest.
// Production uses navigator.locks supplied by the browser and fails closed without it.
const queues = new Map<string, Promise<void>>();
if (typeof navigator !== "undefined" && !navigator.locks) {
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      async request<T>(name: string, callback: () => T | Promise<T>): Promise<T> {
        const previous = queues.get(name) ?? Promise.resolve();
        let release!: () => void;
        const next = new Promise<void>((resolve) => {
          release = resolve;
        });
        queues.set(name, next);
        await previous;
        try {
          return await callback();
        } finally {
          release();
          if (queues.get(name) === next) queues.delete(name);
        }
      },
    },
  });
}
