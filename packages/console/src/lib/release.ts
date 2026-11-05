declare const __SEAM_RELEASE__: { sourceCommit: string; sourceBranch: string; dirty: boolean };
export const RELEASE = typeof __SEAM_RELEASE__ === "undefined" ? undefined : __SEAM_RELEASE__;
