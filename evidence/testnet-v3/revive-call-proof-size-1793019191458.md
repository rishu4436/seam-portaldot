# Revive revive.call proof_size on V3 (spec 3002) — DRY RUN ONLY

Nothing was signed, submitted or sent. No signature bytes (real or dummy) were built. Read RPC only.
Script: `packages/chain/scripts/v3-revive-proof-size.mjs --call`. At finalized #203495 `0xd2fd25a6da5b784ae8a96cfa9623e961d7db68a43d5b1b7e96688eeebce9bb4e`.
Contract `0x86b9cc2d456eed16a6872e1d5646f606a59cd95b` (from revive.Instantiated at #102843 ext 1, the 13-byte Floor-stop deploy). Origin `5ExjaoAwuDG42GbnX6GQBdhNugSv59nXj2HKiUXoS7qkhFV1` (public address only).

| input | ok | result | weight_required ref_time / proof_size | proof limit 0 ok | min passing ref_time / proof_size (search) | proof −1 ok | ref_time −10% ok | limit used (ref ×1.2 / proof cap) | query_call_info total proof_size (cap 0 → cap 1,000,000) | static overhead |
|---|---|---|---|---|---|---|---|---|---|---|
| empty input | true | {"Ok":{"flags":{"bits":"0"},"data":""}} | 5517031 / 13 | false | 5517031 / 13 | false | false | 6620437 / 1000000 | 7725 → 1007725 | 7725 |
| selector 0x12345678 | true | {"Ok":{"flags":{"bits":"0"},"data":""}} | 1361082779 / 12998 | false | 1361082779 / 12998 | false | false | 1633299334 / 1000000 | 7725 → 1007725 | 7725 |

Unlike instantiate (revive-proof-size-1793018489327: weight_required.proof_size 0, proof limit 0 passes), ReviveApi_call DOES meter proof_size on this runtime: weight_required.proof_size is non-zero and a proof_size limit below it fails with OutOfGas (Module 80 error 0x03). So for revive.call the dry run gives a measured execution proof_size; a 0 reading still means unknown, not a bound.
The extrinsic total from query_call_info is the explicit cap plus a static overhead (the cap 0 row shows the overhead alone).
TransactionPaymentApi_query_info was not used: it takes a signed extrinsic.
Limitations: the contract is the 13-byte Floor-stop code, not the escrow; it returns empty data for both inputs. The two inputs give very different weights, so a cap must come from a dry run of the exact input being signed. Not measured: a contract that reads or writes storage, or a call with value. Execution proof_size can change with state, so re-run at signing time.
