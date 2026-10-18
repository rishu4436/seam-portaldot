export type SeamChainErrorCode =
  | "CONNECT_FAILED"
  | "RPC_FAILED"
  | "NODE_MISSING_VALUE"
  | "FACTS_MISMATCH"
  | "PLAN_NOT_SIGNABLE"
  | "ENVELOPE_INVALID"
  | "PAYLOAD_MISMATCH"
  | "BAD_SIGNATURE"
  | "NOT_SIGNED"
  | "SIGNED_MISMATCH"
  | "RUNTIME_CHANGED"
  | "MAINNET_SUBMIT_REFUSED"
  | "TIMEOUT";

export class SeamChainError extends Error {
  readonly code: SeamChainErrorCode;
  constructor(code: SeamChainErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "SeamChainError";
    this.code = code;
  }
}
