# End-to-end test

`npm run test:e2e` starts a throwaway local substrate-contracts-node (port 9955, temp data dir, fresh genesis) with
`packages/chain/scripts/devnode.sh`, runs `packages/chain/tests/devnode.test.ts` against it (setup + `seam_demo`
contract, sequential flow, `batch_all` rollback case, atomic flow; receipts must be `verified`, rollback leaves asset
balances unchanged and only costs the fee), and stops the node on exit, pass or fail. Evidence goes to a temp dir.
Override the port with `SEAM_E2E_PORT`. Run `npm run build` first. Needs network the first time (binary download,
sha256-checked). Local dev chain only, public //Alice account, not Portaldot.

CI: not run in CI. The node is a ~100 MB external release binary downloaded at test time, which makes CI slow and
dependent on GitHub release downloads; CI stays on `npm run build` + `npm test`.
