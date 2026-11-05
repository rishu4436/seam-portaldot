// Keep product documentation aligned with the deployed release while its source PR is under review.
export const RELEASE_BRANCH = "codex/defi-local-20261104";
import { RELEASE } from "./release";
export const SOURCE_URL = `https://github.com/rishu4436/seam-portaldot/tree/${RELEASE?.sourceCommit ?? RELEASE_BRANCH}`;
export const DOCS_URL = `${SOURCE_URL}#5-minute-quickstart`;
export const SDK_DOCS_URL = `https://github.com/rishu4436/seam-portaldot/blob/${RELEASE_BRANCH}/docs/sdk.md`;
export const PAYMENT_EXAMPLE_URL = `${SOURCE_URL}/examples/protected-payment`;
