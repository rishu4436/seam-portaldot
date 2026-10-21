// @vitest-environment jsdom
// Manifest Builder with a fake extension and facts built from the committed real V3 spec 3002 metadata. No real chain, wallet or keystore.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { factsFromMetadata } from "@seam/compiler/browser";
import { ManifestBuilder, actionSupport } from "../ManifestBuilder";
import { buildManifest, importManifest, parseManifestJson } from "../../lib/manifestbuilder";
import { exportManifestText } from "../ManifestBuilder";
import { parseManifest } from "@seam/compiler/browser";
import type { V3FactsResult } from "../../lib/v3facts";

afterEach(cleanup);
const ALICE = "5HEuRGmZgmP86h4MPUcCmYWRi5dE8QKCSgf3JMGCTveyqKpE";
const injected = () => ({
  "polkadot-js": {
    enable: async () => ({
      accounts: { get: async () => [{ address: ALICE, name: "seam-demo" }] },
      signer: {},
    }),
  },
});
// Tests run from packages/console.
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
// Same real facts with Nfts.mint marked not observed, to show an unsupported action and its reason.
const facts = {
  ...real,
  capabilities: {
    ...real.capabilities,
    "Nfts.mint": { ...real.capabilities["Nfts.mint"], status: "not_observed" },
  },
};
const factsStep = vi.fn(
  async (): Promise<V3FactsResult> => ({ ok: true, facts, report: {} }) as unknown as V3FactsResult,
);

describe("Manifest builder", () => {
  it("marks actions unsupported with a reason from live facts", () => {
    const s = actionSupport(facts as never);
    expect(s.find((x) => x.kind === "assets.transfer")?.supported).toBe(true);
    expect(s.find((x) => x.kind === "nfts.mint")).toMatchObject({ supported: false });
    expect(s.find((x) => x.kind === "nfts.mint")?.reason).toMatch(/Nfts\.mint/);
    expect(s.find((x) => x.kind === "nfts.mint")?.cause).toBe("NO_OBSERVED_V3_METADATA");
    expect(s.find((x) => x.kind === "revive.call")?.supported).toBe(true);
    expect(actionSupport().every((x) => !x.supported)).toBe(true);
  });

  it("uses the connected account as signer and hands the manifest to the compiler", async () => {
    const compile = vi.fn(async () => ({ ok: true as const, plan: { digest: "0x1" } }));
    render(
      <ManifestBuilder
        getInjected={injected as never}
        transportFor={() => vi.fn()}
        factsStep={factsStep}
        compile={compile}
      />,
    );
    fireEvent.click(screen.getByText("Connect wallet"));
    await screen.findByRole("option", { name: /seam-demo/ });
    fireEvent.click(screen.getByText("Read live facts"));
    await screen.findByText(/Live runtime:/);
    // Only supported kinds are offered; nfts.mint is listed as unavailable with its cause, not as a button.
    expect(screen.queryByText("+ nfts.mint")).toBeNull();
    const un = screen.getByRole("list", { name: "Unavailable actions" });
    expect(un.querySelector('[data-kind="nfts.mint"]')!.textContent).toMatch(
      /nfts\.mint NO_OBSERVED_V3_METADATA: .*Nfts\.mint/,
    );
    fireEvent.click(screen.getByText("+ assets.transfer"));
    fireEvent.change(screen.getByLabelText("step1 assetId"), { target: { value: "806707" } });
    fireEvent.change(screen.getByLabelText("step1 amount"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("step1 recipient"), { target: { value: ALICE } });
    fireEvent.click(screen.getByText("Compile against live runtime"));
    await waitFor(() => expect(compile).toHaveBeenCalled());
    const [m] = compile.mock.calls[0] as unknown as [ReturnType<typeof buildManifest>];
    expect(m.signer.value).toBe(ALICE);
    expect(m.chain?.specVersion).toBe(3002);
    expect(m.actions[0]).toMatchObject({
      kind: "assets.transfer",
      args: { assetId: "806707", amount: "1" },
    });
  });

  it("blocks compile with no wallet and says why", () => {
    render(<ManifestBuilder getInjected={() => undefined} factsStep={factsStep} />);
    expect(
      screen.getByText("Compile against live runtime").closest("button")!.hasAttribute("disabled"),
    ).toBe(true);
    expect(screen.getByText(/Connect a wallet/)).toBeTruthy();
  });

  it("reports a missing extension", async () => {
    render(<ManifestBuilder getInjected={() => undefined} factsStep={factsStep} />);
    fireEvent.click(screen.getByText("Connect wallet"));
    expect((await screen.findByRole("alert")).textContent).toMatch(/No wallet extension/);
  });

  it("round-trips Manifest JSON and refuses bad files", () => {
    const m = buildManifest(
      ALICE,
      [
        {
          id: "a",
          kind: "assets.mint",
          args: { assetId: "1", amount: "2", recipient: ALICE, x: " " },
        },
      ],
      "required",
    );
    expect(m.atomicRequired).toBe(true);
    expect(m.actions[0].args).not.toHaveProperty("x");
    const r = parseManifestJson(JSON.stringify(m));
    expect(r.ok && r.value.atomicity).toBe("required");
    expect(r.ok && r.value.actions[0].kind).toBe("assets.mint");
    expect(parseManifestJson("{").ok).toBe(false);
    expect(
      parseManifestJson(JSON.stringify({ version: 1, actions: [{ id: "a", kind: "evil.call" }] }))
        .ok,
    ).toBe(false);
    expect(
      parseManifestJson(
        JSON.stringify({
          version: 1,
          actions: [
            { id: "a", kind: "assets.mint" },
            { id: "a", kind: "assets.mint" },
          ],
        }),
      ).ok,
    ).toBe(false);
  });

  it("export uses serializeManifest (canonical) and the file imports back via parseManifest", () => {
    const m = buildManifest(
      ALICE,
      [
        {
          id: "a",
          kind: "assets.transfer",
          args: { assetId: "806707", amount: "1", recipient: ALICE },
        },
      ],
      "sequential",
      {
        genesisHash: (facts as { fingerprint: { genesisHash: string } }).fingerprint.genesisHash,
        specVersion: 3002,
      },
    );
    const e = exportManifestText(m);
    if (!e.ok) throw new Error(JSON.stringify(e.issues));
    expect(parseManifest(e.text).ok).toBe(true);
    const back = importManifest(e.text);
    expect(back.ok && back.value.actions[0]).toMatchObject({ id: "a", kind: "assets.transfer" });
    // Canonical: exporting the imported draft again gives the same text.
    expect(exportManifestText(m)).toEqual(e);
  });

  it("import shows every issue with code, message and path", () => {
    const bad = importManifest(
      JSON.stringify({
        version: 1,
        signer: { type: "ss58", value: ALICE },
        actions: [{ id: "a", kind: "evil.call", args: {} }],
        extra: 1,
      }),
    );
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.issues.length).toBeGreaterThan(0);
    for (const i of bad.issues) {
      expect(typeof i.code).toBe("string");
      expect(typeof i.message).toBe("string");
    }
    expect(bad.issues.some((i) => i.path)).toBe(true);
    const notJson = importManifest("{");
    expect(!notJson.ok && notJson.issues[0]!.code).toBe("MANIFEST_INVALID");
  });

  it("import with live facts runs the compiler check (an unavailable kind is refused with its issues)", () => {
    const text = JSON.stringify({
      version: 1,
      signer: { type: "ss58", value: ALICE },
      actions: [{ id: "n", kind: "nfts.mint", args: {} }],
    });
    const r = importManifest(text, facts);
    expect(r.ok).toBe(false);
  });
});
