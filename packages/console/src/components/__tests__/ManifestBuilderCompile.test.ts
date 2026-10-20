// @vitest-environment node
// Browser compiler wiring on the committed real V3 spec 3002 metadata. Node environment: jsdom's
// Uint8Array differs from the one @polkadot/util-crypto checks, which breaks SS58 checksums there.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { factsFromMetadata } from "@seam/compiler/browser";
import { browserCompile } from "../ManifestBuilder";
import { buildManifest } from "../../lib/manifestbuilder";

const ALICE = "5HEuRGmZgmP86h4MPUcCmYWRi5dE8QKCSgf3JMGCTveyqKpE";
const root = (p: string) => resolve(process.cwd(), "../..", p);
const demo = JSON.parse(
  readFileSync(root("packages/console/src/demo/v3-demo-transfer.json"), "utf8"),
);
const real = factsFromMetadata({
  metadataHex: readFileSync(
    root("evidence/v3-discovery/portaldot-v3-spec3002-metadata.hex"),
    "utf8",
  ).trim(),
  genesisHash: demo.manifest.chain.genesisHash,
  tokenSymbol: "tPOT",
  tokenDecimals: 14,
});

describe("browserCompile", () => {
  it("compiles the demo manifest with the browser compiler to the committed plan digest", async () => {
    const m = buildManifest(
      demo.manifest.signer.value,
      demo.manifest.actions.map(
        (a: { id: string; kind: string; args: Record<string, unknown> }) => ({
          id: a.id,
          kind: a.kind,
          args: Object.fromEntries(Object.entries(a.args).map(([k, v]) => [k, String(v)])),
        }),
      ),
      "preferred",
      demo.manifest.chain,
    );
    const r = await browserCompile(m, real as never);
    expect(r.ok ? "ok" : r.message).toBe("ok");
    expect(r.ok && (r.plan as { manifestDigest: string }).manifestDigest).toBe(
      demo.plan.manifestDigest,
    );
  });

  it("reports compiler issues against the field that caused them", async () => {
    const m = buildManifest(
      ALICE,
      [
        {
          id: "s1",
          kind: "assets.transfer",
          args: { assetId: "806707", amount: "-5", recipient: ALICE },
        },
      ],
      "sequential",
    );
    const r = await browserCompile(m, real as never);
    expect(r.ok).toBe(false);
    expect(!r.ok && Object.keys(r.fieldErrors ?? {})).toContain("s1 amount");
  });
});
