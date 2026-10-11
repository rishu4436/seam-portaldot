# SEAM

SEAM is a developer execution layer for Portaldot. You describe what you want in one Manifest, and SEAM reads the live runtime, compiles the exact calls, checks them against your policy, gets your wallet's signature, submits, and verifies on chain what actually happened. Every run ends in a receipt anyone can check.

Built for Portaldot Hacker House 2026 (Modular Cloud & Middleware track).

## Packages

| Package | What it does |
| --- | --- |
| `packages/compiler` | Reads runtime metadata and turns a Manifest into exact Portaldot calls and a deterministic plan |
| `packages/policy` | Policy checks, approval binding, runtime lock and the last check before submission |
| `packages/sdk` | Manifest helpers, receipts with event checks, plain explanations, the `seam` CLI |
| `packages/console` | Web console that walks through the whole flow |

`fixtures/` holds a read-only snapshot of the public Portaldot node (block 2,721,455, spec 1002) used by the offline tests.

## Run it

Needs Node 22 or later.

```bash
npm install
npm run build
npm test
npm run dev -w @seam/console
```
