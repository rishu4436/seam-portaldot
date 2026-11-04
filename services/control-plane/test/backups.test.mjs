import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { ControlStore } from "../src/store.mjs";
import { createBackupManager, decryptBackup, restoreBackup } from "../src/backups.mjs";

const KEY = "ab".repeat(32);
async function fixture(task) {
  const directory = await mkdtemp(join(tmpdir(), "seam-backup-test-"));
  const store = new ControlStore(join(directory, "live.sqlite"));
  const objects = new Map();
  const storage = {
    put: async (key, value) => objects.set(key, value),
    get: async (key) => objects.get(key),
    list: async () => [...objects.keys()],
    remove: async (key) => objects.delete(key),
  };
  try {
    await task({ directory, store, objects, storage });
  } finally {
    store.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("seam-backup-test-"));
    await rm(directory, { recursive: true, force: true });
  }
}
test("online backup restores complete workspace data and authentication from the encrypted remote copy", async () =>
  fixture(async ({ directory, store, objects, storage }) => {
    const workspace = store.createWorkspace("Restore test");
    const receipt = store.addEvidence(
      workspace.id,
      "Receipt",
      { receipt: { result: "verified" } },
      "test",
    );
    store.saveVerification(workspace.id, receipt.id, { status: "chain_verified" }, "test");
    const monitor = store.createMonitor(
      workspace.id,
      "Runtime",
      900,
      { genesisHash: "chain" },
      "test",
    );
    store.saveCheck(monitor.id, "unchanged", { checked: true });
    const revoked = store.createKey(workspace.id, "Revoked", ["evidence:read"], "test");
    store.revokeKey(workspace.id, revoked.keyId, "test");
    store.audit(workspace.id, "test", "restore.test", workspace.id);
    const manager = createBackupManager({ db: store.db, storage, key: KEY, directory });
    const state = await manager.run();
    assert.equal(state.status, "healthy");
    assert.equal(state.restoreCheck.counts.workspaces, 1);
    const encrypted = objects.get(state.object);
    assert.ok(!encrypted.includes(Buffer.from("Restore test")));
    assert.ok(!encrypted.includes(Buffer.from(workspace.accessKey)));
    const target = join(directory, "recovered.sqlite");
    const result = await restoreBackup(encrypted, KEY, target, directory);
    assert.equal(result.sha256, decryptBackup(encrypted, KEY).sha256);
    const restored = new ControlStore(target);
    try {
      assert.equal(restored.authenticate(workspace.accessKey).workspaceId, workspace.id);
      assert.equal(restored.authenticate(revoked.accessKey), undefined);
      assert.deepEqual(
        restored.evidence(workspace.id, receipt.id),
        store.evidence(workspace.id, receipt.id),
      );
      assert.deepEqual(restored.monitors(workspace.id), store.monitors(workspace.id));
      assert.equal(restored.auditLog(workspace.id).length, store.auditLog(workspace.id).length);
    } finally {
      restored.close();
    }
    const before = await readFile(target);
    await assert.rejects(restoreBackup(encrypted, KEY, target, directory), /EEXIST/);
    assert.deepEqual(await readFile(target), before);
    await manager.close();
  }));
test("wrong keys and tampered ciphertext never create a restored database", async () =>
  fixture(async ({ directory, store, storage, objects }) => {
    store.createWorkspace("Integrity test");
    const manager = createBackupManager({ db: store.db, storage, key: KEY, directory });
    const state = await manager.run(),
      encrypted = objects.get(state.object);
    await assert.rejects(
      restoreBackup(encrypted, "cd".repeat(32), join(directory, "wrong.sqlite"), directory),
      /key/,
    );
    const changed = Buffer.from(encrypted);
    changed[changed.length - 1] ^= 1;
    await assert.rejects(
      restoreBackup(changed, KEY, join(directory, "tampered.sqlite"), directory),
    );
  }));
test("backup requests are single-flight, retention is bounded, and failed read-back cannot replace success", async () =>
  fixture(async ({ directory, store, storage, objects }) => {
    store.createWorkspace("Retention test");
    let uploads = 0;
    const counted = {
      ...storage,
      put: async (...args) => {
        uploads++;
        return storage.put(...args);
      },
    };
    const manager = createBackupManager({
      db: store.db,
      storage: counted,
      key: KEY,
      directory,
      keep: 2,
    });
    await Promise.all([manager.run(), manager.run()]);
    assert.equal(uploads, 1);
    await manager.run();
    await manager.run();
    assert.equal(objects.size, 2);
    const previous = manager.status().lastSuccessAt;
    counted.get = async () => Buffer.from("corrupted");
    await assert.rejects(manager.run(), /restore check failed/);
    assert.equal(manager.status().status, "failed");
    assert.equal(manager.status().lastSuccessAt, previous);
    assert.ok(objects.size >= 2); // Never prune the known-good backups after a failed check.
  }));
