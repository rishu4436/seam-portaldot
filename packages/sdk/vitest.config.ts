import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // CLI integration cases start several fresh Node processes and decode real metadata.
    // Vitest 5 also enforces timeouts for synchronous tests; allow slower Windows hosts.
    testTimeout: 60000,
  },
});
