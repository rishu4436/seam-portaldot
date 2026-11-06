import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test(
  "40 V3 metadata changes stay bounded in a 256 MiB heap without hiding drift",
  { timeout: 180000 },
  () => {
    const run = spawnSync(
      process.execPath,
      [
        "--expose-gc",
        "--max-old-space-size=256",
        fileURLToPath(new URL("./fixtures/runtime-memory-probe.mjs", import.meta.url)),
      ],
      { encoding: "utf8", timeout: 170000, maxBuffer: 1024 * 1024 },
    );
    assert.equal(
      run.status,
      0,
      `Memory probe failed: ${run.error?.message ?? run.stderr.slice(-3000)}`,
    );
    const result = JSON.parse(run.stdout.trim().split("\n").at(-1));
    assert.equal(result.iterations, 40);
    const retained = result.samples.slice(8).map((sample) => sample.heapUsed);
    assert.ok(Math.max(...retained) < 180 * 1024 * 1024, "Steady-state heap exceeded its budget");
    assert.ok(retained.at(-1) - retained[0] < 24 * 1024 * 1024, "Heap grew with metadata history");
  },
);
