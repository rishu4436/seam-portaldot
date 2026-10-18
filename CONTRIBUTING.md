# Contributing

## Setup

```bash
git clone https://github.com/rishu4436/seam-portaldot && cd seam-portaldot
npm ci          # exact versions from package-lock.json (Node 20+)
npm run build   # compiler, policy, chain, sdk, console. Tests use the built output, so build first.
npm test        # every workspace suite; all must pass
```

Optional: `npm run smoke:pack` (installs the packed packages into an empty folder and runs `examples/consumer`) and
`npm run test:e2e` (starts a disposable local chain; needs the node binary described in the README).

## Branches and pull requests

- Branch from `main`: `<area>/<short-topic>`. Never commit to `main` directly.
- One concern per commit; name the SEAM id when the change closes an audit item (for example `SEAM-004: ...`).
- **Test first** for defects: add a test that fails, show it fails, then fix. A fix without a regression test will be asked for one.
- Run `npm run build && npm test` before opening a PR and say the result in the description.
- Keep to your area (compiler, policy, chain, sdk, console, docs). Cross-area changes are discussed in the PR first.
- No secrets in the repo: no seeds, keys or tokens in code, tests, fixtures or evidence.

## Honesty rules

SEAM's value is that its claims are true. A change that makes a claim needs evidence for it.

- **No Portaldot V3 or Revive claims without real evidence.** Evidence means a recorded run or fixture from the actual V3 runtime
  (genesis, spec, metadata hash), kept under `evidence/`. Local runs (a `substrate-contracts-node` dev chain, a local Portaldot dev node at spec 1002)
  are labeled as such and are never described as V3, hosted testnet or mainnet.
- **No `atomic_verified` or "verified" wording** unless the code path really proves it (see `docs/SECURITY_GATES.md`). Unknown stays unknown.
- Recorded or synthetic data in a UI is labeled recorded or synthetic.
- Do not invent users, customers, volume or contacts. Business ideas are labeled as hypotheses.
- Do not hard-code test counts or commit SHAs in docs unless you verified them in the same change.

## Reporting security problems

See [SECURITY.md](SECURITY.md). Do not file them as public issues.
