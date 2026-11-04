// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  archiveEntry,
  importLocalReceipts,
  listLocalReceipts,
  removeLocalReceipt,
  saveLocalReceipt,
} from "../receiptarchive";
const file = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../evidence/testnet-v3/runs/plan-sequential-1792411270138.json",
);
const recorded = () => JSON.parse(readFileSync(file, "utf8"));
describe("receipt archive recovery", () => {
  it("reports unavailable durable storage without claiming a receipt was saved", async () => {
    await expect(listLocalReceipts()).rejects.toThrow(/storage is unavailable/);
  });
  it("recovers complete portable evidence after reopening and deduplicates the same run", async () => {
    const factory = new IDBFactory();
    await saveLocalReceipt(recorded(), factory);
    await saveLocalReceipt(recorded(), factory);
    const rows = await listLocalReceipts(factory);
    expect(rows).toHaveLength(1);
    expect(rows[0].bundle.manifest).toBeDefined();
    expect(rows[0].bundle.runtime).toBeDefined();
    await removeLocalReceipt(rows[0].id, factory);
    expect(await listLocalReceipts(factory)).toEqual([]);
    await importLocalReceipts({ archiveVersion: 1, receipts: rows }, factory);
    expect(await listLocalReceipts(factory)).toEqual(rows);
    const anotherDevice = new IDBFactory();
    await importLocalReceipts({ archiveVersion: 1, receipts: rows }, anotherDevice);
    expect(await listLocalReceipts(anotherDevice)).toEqual(rows);
  });
  it("refuses a mixed valid/corrupt archive atomically and rejects secret fields", async () => {
    const factory = new IDBFactory(),
      valid = archiveEntry(recorded());
    const bad = structuredClone(valid);
    bad.bundle.plan.steps[0].encodedCall = "0x0000";
    await expect(
      importLocalReceipts({ archiveVersion: 1, receipts: [valid, bad] }, factory),
    ).rejects.toThrow(/integrity/);
    expect(await listLocalReceipts(factory)).toEqual([]);
    const secret = recorded();
    secret.plan.signature = "do-not-store";
    await expect(saveLocalReceipt(secret, factory)).rejects.toThrow(/secret/);
  });
  it("validates schema versions and preserves newer local receipt revisions on import", async () => {
    const factory = new IDBFactory();
    await expect(importLocalReceipts({ archiveVersion: 2, receipts: [] }, factory)).rejects.toThrow(
      /version 1/,
    );
    const recent = archiveEntry(recorded(), "2026-11-04T10:00:00.000Z");
    const old = archiveEntry(recorded(), "2026-11-03T10:00:00.000Z");
    await importLocalReceipts({ archiveVersion: 1, receipts: [recent] }, factory);
    await importLocalReceipts({ archiveVersion: 1, receipts: [old] }, factory);
    expect((await listLocalReceipts(factory))[0].savedAt).toBe(recent.savedAt);
  });
});
