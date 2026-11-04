import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlPlane, validateBundle } from "../src/server.mjs";
import { createReadRpc, RPC_URL } from "../src/live.mjs";

const root = "seam_root_" + "test-only-".repeat(6);
const baseline = {
  genesisHash: "chain",
  specName: "test",
  specVersion: 1,
  transactionVersion: 1,
  layoutHash: "layout",
  metadataHash: "raw1",
};
const evidence = {
  bundleVersion: 1,
  receipt: { receiptVersion: 1 },
  plan: { steps: [{ actionId: "pay" }] },
};
const apps = [],
  directories = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
async function start(options = {}) {
  const app = createControlPlane({
    bootstrapToken: root,
    runtime: async () => baseline,
    verify: async () => ({ status: "unknown", notes: ["Not yet proven"] }),
    worker: false,
    ...options,
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  apps.push(app);
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (path, { key = root, method = "GET", body, headers = {} } = {}) => {
    const response = await fetch(url + path, {
      method,
      headers: {
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return {
      status: response.status,
      body: response.status === 204 ? null : await response.json(),
      headers: response.headers,
    };
  };
  return { ...app, request };
}
async function workspace(app, name = "Test team") {
  return (await app.request("/v1/workspaces", { method: "POST", body: { name } })).body;
}

test("startup refuses weak operator credentials", () => {
  assert.throws(() => createControlPlane({ bootstrapToken: "weak" }), /at least 32/);
});
test("only the operator can inspect or trigger full service backups", async () => {
  let runs = 0;
  const manager = {
    status: () => ({ enabled: true, status: "healthy" }),
    run: async () => {
      runs++;
      return { status: "healthy" };
    },
  };
  const app = await start({ backups: () => manager });
  const team = await workspace(app);
  const path = "/v1/operations/backups";
  assert.equal((await app.request(path, { key: null })).status, 401);
  assert.equal((await app.request(path, { key: team.accessKey })).status, 403);
  assert.equal((await app.request(path, { key: team.accessKey, method: "POST" })).status, 403);
  assert.equal(runs, 0);
  assert.equal((await app.request(path)).body.status, "healthy");
  assert.equal((await app.request(path, { method: "POST" })).status, 200);
  assert.equal(runs, 1);
});
test("a failed verification attempt replaces a stale successful badge with an explicit unknown result", async () => {
  let offline = false;
  const app = await start({
    verify: async () => {
      if (offline) throw new Error("node offline");
      return { status: "chain_verified" };
    },
  });
  const team = await workspace(app),
    path = `/v1/workspaces/${team.id}`;
  const saved = (
    await app.request(`${path}/evidence`, {
      method: "POST",
      body: { name: "Run", bundle: evidence },
    })
  ).body;
  await app.request(`${path}/evidence/${saved.id}/verify`, { method: "POST" });
  offline = true;
  const attempt = await app.request(`${path}/evidence/${saved.id}/verify`, { method: "POST" });
  assert.equal(attempt.status, 200);
  assert.equal(attempt.body.status, "unknown");
  const stored = (await app.request(`${path}/evidence/${saved.id}`)).body;
  assert.equal(stored.verification.status, "unknown");
  assert.ok(stored.verification.checkedAt);
  assert.ok(stored.verified_at);
});
test("tenant isolation, read-only keys and revocation are enforced by the server", async () => {
  const app = await start(),
    a = await workspace(app),
    b = await workspace(app, "Other team");
  const path = `/v1/workspaces/${a.id}`;
  assert.equal(
    (
      await app.request(path + "/evidence", {
        key: undefined,
        headers: { Authorization: "invalid" },
      })
    ).status,
    401,
  );
  assert.equal(
    (await app.request(`/v1/workspaces/${b.id}/evidence`, { key: a.accessKey })).status,
    403,
  );
  const member = await app.request(path + "/keys", {
    method: "POST",
    key: a.accessKey,
    body: { name: "Reviewer" },
  });
  assert.equal(member.status, 201);
  assert.equal((await app.request(path + "/evidence", { key: member.body.accessKey })).status, 200);
  assert.equal(
    (
      await app.request(path + "/evidence", {
        method: "POST",
        key: member.body.accessKey,
        body: { name: "receipt", bundle: evidence },
      })
    ).status,
    403,
  );
  assert.equal((await app.request(path + "/keys", { key: member.body.accessKey })).status, 403);
  assert.equal(
    (
      await app.request(path + `/keys/${member.body.keyId}/revoke`, {
        method: "POST",
        key: a.accessKey,
      })
    ).status,
    200,
  );
  assert.equal((await app.request(path + "/evidence", { key: member.body.accessKey })).status, 401);
  const keys = (await app.request(path + "/keys")).body;
  assert.ok(!JSON.stringify(keys).includes(member.body.accessKey));
  assert.ok(!JSON.stringify(keys).includes("token_hash"));
});
test("evidence persists across restarts, deduplicates and never inherits client verification claims", async () => {
  const directory = mkdtempSync(join(tmpdir(), "seam-control-"));
  directories.push(directory);
  const database = join(directory, "test.sqlite");
  let app = await start({ database });
  const w = await workspace(app);
  const path = `/v1/workspaces/${w.id}`;
  const added = await app.request(path + "/evidence", {
    method: "POST",
    body: { name: "payment", bundle: evidence },
  });
  assert.equal(added.status, 201);
  const duplicate = await app.request(path + "/evidence", {
    method: "POST",
    body: { name: "payment", bundle: evidence },
  });
  assert.deepEqual(duplicate.body, { id: added.body.id, duplicate: true });
  const row = await app.request(path + `/evidence/${added.body.id}`);
  assert.equal(row.body.verification, null);
  await app.close();
  apps.splice(apps.indexOf(app), 1);
  app = await start({ database });
  assert.equal(
    (await app.request(path + "/evidence", { key: w.accessKey })).body.evidence.length,
    1,
  );
  assert.equal(
    (await app.request(path + `/evidence/${added.body.id}/verify`, { method: "POST" })).body.status,
    "unknown",
  );
  const exported = await app.request(path + "/export");
  assert.equal(exported.body.evidence[0].verification.status, "unknown");
  assert.ok(!JSON.stringify(exported.body).includes(w.accessKey));
  assert.equal((await app.request(path + "/audit")).body.audit[0].action, "evidence.verified");
});
test("secret-bearing, oversized and forged proof uploads are rejected", async () => {
  const app = await start(),
    w = await workspace(app),
    path = `/v1/workspaces/${w.id}/evidence`;
  for (const bundle of [
    { ...evidence, receipt: { signature: "secret" } },
    { ...evidence, verification: { status: "chain_verified" } },
    { ...evidence, receipt: { note: w.accessKey } },
    JSON.parse('{"bundleVersion":1,"receipt":{"__proto__":{}},"plan":{"steps":[{}]}}'),
  ]) {
    assert.equal(
      (await app.request(path, { method: "POST", body: { name: "bad", bundle } })).status,
      400,
    );
  }
  assert.equal(
    (
      await app.request(path, {
        method: "POST",
        body: { name: "large", bundle: { ...evidence, receipt: { note: "x".repeat(600000) } } },
      })
    ).status,
    413,
  );
  assert.equal((await app.request(path)).body.evidence.length, 0);
  assert.throws(() => validateBundle({ ...evidence, plan: { steps: Array(17).fill({}) } }), /1–16/);
});
test("monitor checks distinguish layout changes, benign metadata drift and unreadable state", async () => {
  let snapshot = baseline;
  const app = await start({
    runtime: async () => {
      if (snapshot instanceof Error) throw snapshot;
      return snapshot;
    },
  });
  const w = await workspace(app),
    path = `/v1/workspaces/${w.id}/monitors`;
  assert.equal(
    (await app.request(path, { method: "POST", body: { name: "too fast", intervalSeconds: 1 } }))
      .status,
    400,
  );
  const monitor = (
    await app.request(path, { method: "POST", body: { name: "V3 runtime", intervalSeconds: 300 } })
  ).body;
  assert.equal(
    (await app.request(`${path}/${monitor.id}/check`, { method: "POST" })).body.status,
    "unchanged",
  );
  snapshot = { ...baseline, metadataHash: "raw2" };
  const drift = (await app.request(`${path}/${monitor.id}/check`, { method: "POST" })).body;
  assert.equal(drift.status, "unchanged");
  assert.equal(drift.detail.metadataOnlyDrift, true);
  snapshot = { ...baseline, specVersion: 2 };
  assert.equal(
    (await app.request(`${path}/${monitor.id}/check`, { method: "POST" })).body.status,
    "changed",
  );
  snapshot = new Error("node offline");
  assert.equal(
    (await app.request(`${path}/${monitor.id}/check`, { method: "POST" })).body.status,
    "unknown",
  );
  assert.equal((await app.request(`${path}/${monitor.id}`)).body.checks.length, 4);
  await app.request(`${path}/${monitor.id}`, { method: "PATCH", body: { enabled: false } });
  assert.equal(app.store.due().length, 0);
});
test("CORS is restricted, authentication is required and responses carry safe metadata", async () => {
  const app = await start({ origins: ["https://seam.example"] });
  const health = await app.request("/healthz", { key: null });
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("x-content-type-options"), "nosniff");
  assert.ok(health.headers.get("x-request-id"));
  assert.equal((await app.request("/v1/session", { key: null })).status, 401);
  assert.equal(
    (await app.request("/v1/session", { headers: { Origin: "https://evil.example" } })).status,
    403,
  );
  const allowed = await app.request("/v1/session", { headers: { Origin: "https://seam.example" } });
  assert.equal(allowed.headers.get("access-control-allow-origin"), "https://seam.example");
  assert.equal(
    (
      await app.request("/v1/session", {
        method: "OPTIONS",
        headers: { Origin: "https://seam.example" },
      })
    ).status,
    204,
  );
});
test("chain transport refuses writes and mismatched response IDs", async () => {
  let calls = 0;
  const send = createReadRpc(
    async () => {
      calls++;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: "wrong", result: true }));
    },
    Infinity,
    [RPC_URL],
  );
  await assert.rejects(send("author_submitExtrinsic", ["0x"]), /read-only/);
  assert.equal(calls, 0);
  await assert.rejects(send("chain_getFinalizedHead", []), /mismatched/);
});
test("chain transport stops reading oversized node responses", async () => {
  const send = createReadRpc(async () => new Response("x".repeat(8 * 1024 * 1024 + 1)), Infinity, [
    RPC_URL,
  ]);
  await assert.rejects(send("state_getMetadata", []), /too large/);
});
