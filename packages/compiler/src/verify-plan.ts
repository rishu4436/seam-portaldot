// Fail-closed check that a plan's call bytes are exactly what this manifest compiles to on the live runtime.
// Pure, browser-safe. Closes the "edited plan + recomputed digest" hole: policy reads decodedArgs, the wallet
// signs encodedCall, so both must come from one fresh compile against the live facts the runtime lock checked.
// Facts are never taken from the plan (it only carries a fingerprintDigest, which is reported, not trusted).
import { compile, computePlanDigest } from "./compile.js";
import { canonicalJson } from "./canonical.js";
import {
  SeamCompileError,
  type CompileOptions,
  type Hex,
  type Manifest,
  type Plan,
  type RuntimeFacts,
} from "./types.js";

export type VerifyPlanCode =
  | "STEP_BYTES_MISMATCH"
  | "OUTER_CALL_MISMATCH"
  | "SIGNED_CALL_MISMATCH"
  | "SIGNED_CALL_MISSING"
  | "SIGNED_CALL_COUNT"
  | "STEP_COUNT_MISMATCH"
  | "STEP_BODY_MISMATCH"
  | "PLAN_BODY_MISMATCH"
  | "PLAN_DIGEST_INVALID"
  | "NOT_EXECUTABLE"
  | "COMPILE_FAILED";

export interface VerifyPlanIssue {
  code: VerifyPlanCode;
  /** Step index, or null for the outer call / the plan as a whole. */
  stepIndex: number | null;
  expected?: string | null;
  actual?: string | null;
  message: string;
}

export interface VerifyPlanOptions extends CompileOptions {
  /**
   * Call bytes decoded from the signed extrinsic(s): one per step for sequential plans, exactly one (the
   * Utility.batch_all) for atomic plans. Compared with the FRESH compile, not only with the plan.
   */
  signedCalls?: (string | Uint8Array)[];
}

export type VerifyPlanResult =
  | {
      ok: true;
      planDigest: Hex;
      freshPlanDigest: Hex;
      /** True when only the facts binding differs (fingerprint/plan digest); every byte and body matched. */
      fingerprintDiffers: boolean;
    }
  | { ok: false; issues: VerifyPlanIssue[] };

const toHex = (c: string | Uint8Array): string =>
  typeof c === "string"
    ? c.toLowerCase()
    : "0x" + Array.from(c, (b) => b.toString(16).padStart(2, "0")).join("");
const low = (s: string | null | undefined) => (typeof s === "string" ? s.toLowerCase() : null);
const isAtomic = (p: Plan) => p.mode === "atomic_verified" || p.mode === "atomic_unverified";
const canon = (v: unknown) => {
  try {
    return canonicalJson(v as never);
  } catch {
    return JSON.stringify(v) ?? "undefined";
  }
};

export function verifyPlan(
  manifest: Manifest,
  plan: Plan,
  liveFacts: RuntimeFacts,
  options: VerifyPlanOptions = {},
): VerifyPlanResult {
  const issues: VerifyPlanIssue[] = [];
  const bad = (i: VerifyPlanIssue) => issues.push(i);
  try {
    const { signedCalls, ...compileOptions } = options;
    let fresh: Plan;
    try {
      fresh = compile(manifest, liveFacts, compileOptions);
    } catch (e) {
      const msg = e instanceof SeamCompileError ? e.message : (e as Error)?.message;
      return {
        ok: false,
        issues: [
          {
            code: "COMPILE_FAILED",
            stepIndex: null,
            message: `the manifest does not compile on the live runtime: ${msg}`,
          },
        ],
      };
    }
    if (!plan || typeof plan !== "object" || !Array.isArray(plan.steps))
      return {
        ok: false,
        issues: [{ code: "PLAN_BODY_MISMATCH", stepIndex: null, message: "plan is malformed" }],
      };
    if (computePlanDigest(plan) !== plan.planDigest)
      bad({
        code: "PLAN_DIGEST_INVALID",
        stepIndex: null,
        expected: computePlanDigest(plan),
        actual: plan.planDigest,
        message: "plan.planDigest does not match the plan's content",
      });
    if (
      fresh.mode === "unavailable" ||
      fresh.steps.some((s) => s.status !== "ok" || !s.encodedCall)
    )
      bad({
        code: "NOT_EXECUTABLE",
        stepIndex: null,
        message: "the fresh compile has unavailable steps; there is nothing exact to sign",
      });
    if (plan.steps.length !== fresh.steps.length)
      bad({
        code: "STEP_COUNT_MISMATCH",
        stepIndex: null,
        expected: String(fresh.steps.length),
        actual: String(plan.steps.length),
        message: "plan step count differs from the fresh compile",
      });
    fresh.steps.forEach((f, i) => {
      const p = plan.steps[i];
      if (!p) return;
      if (!f.encodedCall || low(p.encodedCall) !== low(f.encodedCall))
        bad({
          code: "STEP_BYTES_MISMATCH",
          stepIndex: i,
          expected: f.encodedCall,
          actual: p.encodedCall ?? null,
          message: `step ${i} call bytes differ from the fresh compile`,
        });
      if (canon(p) !== canon(f))
        bad({
          code: "STEP_BODY_MISMATCH",
          stepIndex: i,
          expected: canon(f.decodedArgs),
          actual: canon(p.decodedArgs),
          message: `step ${i} (kind, indices, decoded args or status) differs from the fresh compile`,
        });
    });
    if (isAtomic(fresh) || isAtomic(plan)) {
      const e = fresh.outerCall?.encodedCall ?? null;
      const a = plan.outerCall?.encodedCall ?? null;
      if (!e || low(a) !== low(e) || canon(plan.outerCall) !== canon(fresh.outerCall))
        bad({
          code: "OUTER_CALL_MISMATCH",
          stepIndex: null,
          expected: e,
          actual: a,
          message: "the atomic batch_all call differs from the fresh compile",
        });
    }
    // Everything except the facts binding must be identical (same comparison as rebindPlan).
    const body = (x: Plan) => {
      const { fingerprintDigest: _f, planDigest: _d, ...rest } = x;
      return canon(rest);
    };
    if (body(plan) !== body(fresh))
      bad({
        code: "PLAN_BODY_MISMATCH",
        stepIndex: null,
        message:
          "plan (mode, signer, manifestDigest, steps or outer call) differs from the fresh compile",
      });
    if (signedCalls !== undefined) {
      const want = isAtomic(fresh)
        ? [fresh.outerCall?.encodedCall ?? null]
        : fresh.steps.map((s) => s.encodedCall);
      if (!Array.isArray(signedCalls) || signedCalls.length !== want.length)
        bad({
          code: "SIGNED_CALL_COUNT",
          stepIndex: null,
          expected: String(want.length),
          actual: String(Array.isArray(signedCalls) ? signedCalls.length : "none"),
          message: "number of signed calls differs from the calls to sign",
        });
      want.forEach((w, i) => {
        const s = Array.isArray(signedCalls) ? signedCalls[i] : undefined;
        if (
          s === undefined ||
          s === null ||
          (typeof s !== "string" && !(s instanceof Uint8Array))
        ) {
          bad({
            code: "SIGNED_CALL_MISSING",
            stepIndex: isAtomic(fresh) ? null : i,
            expected: w,
            actual: null,
            message: `signed call ${i} is missing`,
          });
          return;
        }
        const got = toHex(s);
        if (!w || got !== low(w))
          bad({
            code: "SIGNED_CALL_MISMATCH",
            stepIndex: isAtomic(fresh) ? null : i,
            expected: w,
            actual: got,
            message: `signed call ${i} differs from the fresh compile`,
          });
      });
    }
    if (issues.length) return { ok: false, issues };
    return {
      ok: true,
      planDigest: plan.planDigest,
      freshPlanDigest: fresh.planDigest,
      fingerprintDiffers: fresh.fingerprintDigest !== plan.fingerprintDigest,
    };
  } catch (e) {
    return {
      ok: false,
      issues: [
        {
          code: "COMPILE_FAILED",
          stepIndex: null,
          message: `verification failed: ${(e as Error)?.message}`,
        },
      ],
    };
  }
}

/** Throws SeamCompileError (code PLAN_MISMATCH) unless verifyPlan is ok. */
export function assertPlanVerified(
  manifest: Manifest,
  plan: Plan,
  liveFacts: RuntimeFacts,
  options: VerifyPlanOptions = {},
): Extract<VerifyPlanResult, { ok: true }> {
  const r = verifyPlan(manifest, plan, liveFacts, options);
  if (r.ok) return r;
  throw new SeamCompileError(
    r.issues.map((i) => ({
      code: "PLAN_MISMATCH",
      path: i.stepIndex === null ? i.code : `steps[${i.stepIndex}]:${i.code}`,
      message: i.message,
    })),
  );
}
