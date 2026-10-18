import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blake2AsU8a } from "@polkadot/util-crypto";
import { u8aToHex } from "@polkadot/util";
import { SeamChainError } from "./errors.js";
import { PORTALDOT_MAINNET_GENESIS } from "./submit.js";
import { decodeRuntime, metadataVersionOf } from "./runtime.js";
import {
  factsFromChainInputs,
  listRpcMethods,
  readChainInputs,
  signedExtensionsOf,
  snapshotFromNode,
} from "./discover.js";
import { withClient, type ConnectOptions, type Endpoint, type RpcClient } from "./rpc.js";
import type { ChainInputs, ChainPropertiesJson, SnapshotJson } from "./types.js";

/**
 * Read-only V3 capability discovery. Everything here reads; nothing signs or submits.
 * A capability is `observed` (seen in what the node returned), `absent` (the node returned the relevant list and the item is not in it)
 * or `NOT VERIFIED` (the list that would answer it was not obtained). Nothing is ever guessed.
 */
export type CapabilityStatus = "observed" | "absent" | "NOT VERIFIED";
export interface CapabilityEntry {
  item: string;
  kind: "pallet" | "call" | "runtimeApi" | "signedExtension" | "rpcMethod";
  status: CapabilityStatus;
  detail?: string;
}

/** Plain description of what a runtime exposes. `undefined` means "could not be read", which is not the same as empty. */
export interface RuntimeModel {
  /** Pallet name -> call names (snake_case, as in the metadata). A pallet without calls maps to []. */
  pallets?: Record<string, string[]>;
  signedExtensions?: string[];
  /** Runtime API names found in the metadata (V15+). */
  metadataApis?: string[];
  /** state_getRuntimeVersion.apis: [blake2_64(name) hex, version]. */
  runtimeVersionApis?: [string, number][];
  rpcMethods?: string[];
}

const PALLETS = ["Revive", "Contracts", "Nfts", "Assets", "Utility"] as const;
const CALLS: [string, string][] = [
  ["Revive", "call"],
  ["Revive", "instantiate"],
  ["Revive", "instantiate_with_code"],
  ["Revive", "upload_code"],
  ["Revive", "map_account"],
  ["Contracts", "call"],
  ["Contracts", "instantiate"],
  ["Contracts", "instantiate_with_code"],
  ["Contracts", "upload_code"],
  ["Nfts", "mint"],
  ["Assets", "transfer_keep_alive"],
  ["Assets", "mint"],
  ["Utility", "batch_all"],
];
const RUNTIME_APIS = ["ReviveApi", "ContractsApi"] as const;
const RPC_METHODS = ["state_call", "system_dryRun", "payment_queryInfo", "contracts_call"] as const;

/** blake2b-64 of the API name: how a runtime lists its APIs in state_getRuntimeVersion. */
export function runtimeApiId(name: string): string {
  return u8aToHex(blake2AsU8a(name, 64));
}

/** Pure: a runtime model -> the capability entries. */
export function capabilitiesFromModel(m: RuntimeModel): CapabilityEntry[] {
  const out: CapabilityEntry[] = [];
  const pallets = m.pallets;
  for (const p of PALLETS) {
    out.push(
      pallets
        ? { item: p, kind: "pallet", status: p in pallets ? "observed" : "absent" }
        : {
            item: p,
            kind: "pallet",
            status: "NOT VERIFIED",
            detail: "metadata could not be decoded",
          },
    );
  }
  for (const [p, c] of CALLS) {
    const item = `${p}.${c}`;
    if (!pallets)
      out.push({
        item,
        kind: "call",
        status: "NOT VERIFIED",
        detail: "metadata could not be decoded",
      });
    else if (!(p in pallets))
      out.push({
        item,
        kind: "call",
        status: "absent",
        detail: `pallet ${p} is not in the metadata`,
      });
    else out.push({ item, kind: "call", status: pallets[p]!.includes(c) ? "observed" : "absent" });
  }
  for (const api of RUNTIME_APIS) {
    const id = runtimeApiId(api);
    const inMeta = m.metadataApis?.includes(api);
    const inVersion = m.runtimeVersionApis?.some(([i]) => i.toLowerCase() === id);
    if (inMeta || inVersion) {
      const v = m.runtimeVersionApis?.find(([i]) => i.toLowerCase() === id)?.[1];
      out.push({
        item: api,
        kind: "runtimeApi",
        status: "observed",
        detail: `${inMeta ? "in metadata" : ""}${inMeta && inVersion ? " and " : ""}${inVersion ? `in runtime version apis (id ${id}, v${v})` : ""}`,
      });
    } else if (m.metadataApis || m.runtimeVersionApis) {
      out.push({
        item: api,
        kind: "runtimeApi",
        status: "absent",
        detail: `not in ${[m.metadataApis && "metadata apis", m.runtimeVersionApis && "runtime version apis"].filter(Boolean).join(" or ")} (id ${id})`,
      });
    } else
      out.push({
        item: api,
        kind: "runtimeApi",
        status: "NOT VERIFIED",
        detail: "neither metadata apis nor runtime version apis were read",
      });
  }
  for (const m_ of RPC_METHODS) {
    out.push(
      m.rpcMethods
        ? { item: m_, kind: "rpcMethod", status: m.rpcMethods.includes(m_) ? "observed" : "absent" }
        : {
            item: m_,
            kind: "rpcMethod",
            status: "NOT VERIFIED",
            detail: "rpc_methods was not available",
          },
    );
  }
  if (m.signedExtensions)
    for (const s of m.signedExtensions)
      out.push({ item: s, kind: "signedExtension", status: "observed" });
  else
    out.push({
      item: "signedExtensions",
      kind: "signedExtension",
      status: "NOT VERIFIED",
      detail: "metadata could not be decoded",
    });
  return out;
}

/** Pure: raw chain inputs -> runtime model, by decoding the node's own metadata (pinned types only matter for pre-V14 metadata). */
export function runtimeModelFromInputs(
  inputs: ChainInputs,
  opts: { typesBundle?: string; rpcMethods?: string[] } = {},
): RuntimeModel {
  const facts = factsFromChainInputs(
    inputs,
    opts.typesBundle ? { typesBundle: opts.typesBundle } : {},
  );
  const rt = decodeRuntime(facts);
  const latest = rt.metadata.asLatest;
  const pallets: Record<string, string[]> = {};
  for (const p of latest.pallets) {
    const calls = p.calls.isSome
      ? rt.registry.lookup
          .getSiType(p.calls.unwrap().type)
          .def.asVariant.variants.map((v) => v.name.toString())
      : [];
    pallets[p.name.toString()] = calls;
  }
  const model: RuntimeModel = {
    pallets,
    signedExtensions: signedExtensionsOf(
      inputs.metadataHex,
      opts.typesBundle ?? facts.source.typesBundle,
    ),
  };
  const apis = (latest as unknown as { apis?: { name: { toString(): string } }[] }).apis;
  if (metadataVersionOf(inputs.metadataHex) >= 15 && apis)
    model.metadataApis = apis.map((a) => a.name.toString());
  if (inputs.runtimeVersion.apis) model.runtimeVersionApis = inputs.runtimeVersion.apis;
  if (opts.rpcMethods) model.rpcMethods = opts.rpcMethods;
  return model;
}

/** The only JSON-RPC methods discovery may send. Anything else (author_*, a state_call outside the list, ...) is refused before it reaches the node. */
export const READ_ONLY_RPC_METHODS: readonly string[] = [
  "chain_getBlockHash",
  "chain_getHeader",
  "chain_getFinalizedHead",
  "state_getMetadata",
  "state_getRuntimeVersion",
  "system_chain",
  "system_properties",
  "rpc_methods",
  "state_call",
];
const READ_ONLY_STATE_CALLS = ["Metadata_metadata_versions"];

export function readOnlyClient(client: RpcClient): RpcClient {
  return {
    async send<T>(method: string, params: unknown[]): Promise<T> {
      if (!READ_ONLY_RPC_METHODS.includes(method))
        throw new SeamChainError("RPC_FAILED", `read-only discovery refuses to send ${method}`);
      if (method === "state_call" && !READ_ONLY_STATE_CALLS.includes(String(params[0])))
        throw new SeamChainError(
          "RPC_FAILED",
          `read-only discovery refuses state_call ${String(params[0])}`,
        );
      return client.send<T>(method, params);
    },
    subscribe: () =>
      Promise.reject(new SeamChainError("RPC_FAILED", "read-only discovery does not subscribe")),
    unsubscribe: () => Promise.resolve(false),
  };
}

export interface V3Capabilities {
  kind: "v3-capabilities";
  /** Always true here: it says what the report is, not what the chain is. */
  readOnly: true;
  generatedAt: string;
  endpoint?: string;
  chain?: {
    systemChain?: string;
    genesisHash: string;
    specName: string;
    specVersion: number;
    transactionVersion: number;
    metadataVersion: number;
    atBlock: number;
    atBlockHash: string;
    /** system_properties exactly as the node returned them (ss58Format, tokenSymbol, tokenDecimals). Never filled in by SEAM. */
    properties?: ChainPropertiesJson;
  };
  metadataVersions?: string;
  rpcMethodsRead: boolean;
  capabilities: CapabilityEntry[];
  /** Set when the metadata could not be decoded; every metadata-derived item is then NOT VERIFIED. */
  decodeError?: string;
}

export interface DiscoverV3Result {
  capabilities: V3Capabilities;
  files: { snapshot?: string; metadata?: string; json: string; md: string };
  snapshot?: SnapshotJson;
}

export function capabilitiesMarkdown(c: V3Capabilities): string {
  const lines = ["# V3 capabilities (read-only discovery)", ""];
  const observedAny = c.capabilities.some((x) => x.status !== "NOT VERIFIED");
  lines.push(
    c.chain
      ? `Source: ${c.endpoint ?? "an RPC client"}, chain "${c.chain.systemChain ?? "unknown"}", ${c.chain.specName} spec ${c.chain.specVersion}, genesis ${c.chain.genesisHash}, block ${c.chain.atBlock}. Read ${c.generatedAt}.`
      : "Source: nothing could be read.",
    "",
  );
  lines.push(
    "**This file only describes what that one node reported. V3 is NOT VERIFIED until this has been run against a real hosted V3 RPC and the output reviewed.**",
    "",
  );
  const props = c.chain?.properties;
  if (props) {
    const show = (v: unknown) => (v === undefined ? "not reported" : JSON.stringify(v));
    lines.push(
      `Chain properties (system_properties): ss58Format ${show(props.ss58Format)}, tokenSymbol ${show(props.tokenSymbol)}, tokenDecimals ${show(props.tokenDecimals)}.`,
      "",
    );
  }
  if (c.decodeError) lines.push(`Metadata could not be decoded: ${c.decodeError}`, "");
  if (!observedAny) lines.push("Nothing was observed.", "");
  lines.push("| item | kind | status | detail |", "|---|---|---|---|");
  for (const e of c.capabilities)
    lines.push(`| ${e.item} | ${e.kind} | ${e.status} | ${e.detail ?? ""} |`);
  return lines.join("\n") + "\n";
}

/**
 * Read-only V3 discovery: reads metadata, runtime version, chain name, genesis and rpc_methods from the node, writes the usual
 * snapshot (via snapshotFromNode) plus `v3-capabilities.json` / `v3-capabilities.md` into outDir. Sends no transaction:
 * the client is wrapped so only the methods in READ_ONLY_RPC_METHODS can leave the process.
 */
export async function discoverV3(
  endpoint: Endpoint,
  outDir: string,
  opts: ConnectOptions & { typesBundle?: string; name?: string } = {},
): Promise<DiscoverV3Result> {
  return withClient(
    endpoint,
    async (rawClient) => {
      const client = readOnlyClient(rawClient);
      const inputs = await readChainInputs(client);
      if (inputs.genesisHash.toLowerCase() === PORTALDOT_MAINNET_GENESIS)
        throw new SeamChainError(
          "MAINNET_SUBMIT_REFUSED",
          "refusing: genesis hash is Portaldot mainnet; nothing was written",
        );
      if (typeof endpoint === "string") inputs.endpoint = endpoint.replace(/\/\/[^@/]*@/, "//");
      const rpcMethods = await listRpcMethods(client).catch(() => undefined);
      const systemChain = await client.send<string>("system_chain", []).catch(() => undefined);
      const metadataVersions = await client
        .send<unknown>("state_call", ["Metadata_metadata_versions", "0x"])
        .then((v) => (typeof v === "string" ? v : undefined))
        .catch(() => undefined);
      const caps: V3Capabilities = {
        kind: "v3-capabilities",
        readOnly: true,
        generatedAt: new Date().toISOString(),
        rpcMethodsRead: rpcMethods !== undefined,
        capabilities: [],
      };
      if (inputs.endpoint) caps.endpoint = inputs.endpoint;
      if (metadataVersions) caps.metadataVersions = metadataVersions;
      let model: RuntimeModel;
      let snapshotFiles:
        { snapshotPath: string; metadataPath: string; snapshot: SnapshotJson } | undefined;
      try {
        model = runtimeModelFromInputs(inputs, {
          ...(opts.typesBundle ? { typesBundle: opts.typesBundle } : {}),
          ...(rpcMethods ? { rpcMethods } : {}),
        });
        const rv = inputs.runtimeVersion;
        caps.chain = {
          ...(systemChain ? { systemChain } : {}),
          genesisHash: inputs.genesisHash,
          specName: rv.specName,
          specVersion: rv.specVersion,
          transactionVersion: rv.transactionVersion,
          metadataVersion: metadataVersionOf(inputs.metadataHex),
          atBlock: inputs.head.number,
          atBlockHash: inputs.head.hash,
          properties: inputs.properties,
        };
        snapshotFiles = await snapshotFromNode(client, outDir, {
          ...(opts.typesBundle ? { typesBundle: opts.typesBundle } : {}),
          ...(opts.name ? { name: opts.name } : {}),
        });
      } catch (e) {
        caps.decodeError = (e as Error).message;
        model = {
          ...(rpcMethods ? { rpcMethods } : {}),
          ...(inputs.runtimeVersion.apis ? { runtimeVersionApis: inputs.runtimeVersion.apis } : {}),
        };
      }
      caps.capabilities = capabilitiesFromModel(model);
      mkdirSync(outDir, { recursive: true });
      const json = join(outDir, "v3-capabilities.json");
      const md = join(outDir, "v3-capabilities.md");
      writeFileSync(json, JSON.stringify(caps, null, 1) + "\n");
      writeFileSync(md, capabilitiesMarkdown(caps));
      return {
        capabilities: caps,
        files: {
          json,
          md,
          ...(snapshotFiles
            ? { snapshot: snapshotFiles.snapshotPath, metadata: snapshotFiles.metadataPath }
            : {}),
        },
        ...(snapshotFiles ? { snapshot: snapshotFiles.snapshot } : {}),
      };
    },
    opts,
  );
}
