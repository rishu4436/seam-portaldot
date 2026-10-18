// Browser-only entry for the LIVE chain client and wallet signer. Plain JSON-RPC and window.injectedWeb3: no node-only deps and
// no @seam/chain import. Loaded lazily (dynamic import) by the LIVE panel so it stays out of the initial bundle.
export {
  createBrowserChainClient,
  readSigningContext,
  findInFinalized,
  transportFor,
  httpTransport,
  wsTransport,
  RpcError,
  TransportError,
} from "./chainclient";
export type { RpcTransport, ClientOptions } from "./chainclient";
export { createExtensionSigner } from "./extensionsigner";
