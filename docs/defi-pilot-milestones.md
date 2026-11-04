# Seam DeFi pilot and funding evidence

This is an internal planning worksheet. It contains no claimed partner, customer, revenue, valuation, production TVL, audited security, or guaranteed grant eligibility. Local fixture activity must never be presented as live adoption.

## Milestones with reviewable deliverables

| Stage | Deliverable | Evidence / acceptance | Budget inputs to fill |
| --- | --- | --- | --- |
| Local vertical | Swap, scoped approval, deposit/redeem, receipt recovery and portable verification | Reproducible contract and browser tests; threat model; dependency report | Engineering days × agreed daily rate; review days × reviewer rate |
| One V3 integration | Reviewed contract identities, actual liquidity, ERC-20/native mapping, exit path | Maintainer feedback, independent review, authorized testnet wallet evidence for both swap directions and full vault exit | Integration days; independent review quote; test infrastructure; contingency |
| User pilot | Small opted-in cohort executing defined test tasks | Consented interviews, completion/recovery rates, recurring failures, repeated use; separate local from testnet data | Recruitment/support hours; hosting; instrumentation and privacy work |
| SDK integration pilot | One external application integrates quoting, policy review and evidence verification | External integrator's acceptance; integration time and maintenance burden; signed pilot terms only if obtained | SDK/docs/support time; service costs; proposed price hypothesis |

Do not choose a fundraising amount before completing these inputs. A request should map each tranche to a deliverable, reviewer and acceptance evidence, with ownership, reporting cadence and a defined stop condition. Funding-program availability must be rechecked on official pages at application time.

## Metrics to collect

The UI's **Export pilot metrics** generates device-local aggregate counters without external telemetry: recorded plans, accounts on that device, independently checked executions by action, wallet rejections, unresolved requests and failed verifications. Networks are separated. Counts are unauthenticated and not a global dashboard. They are not a substitute for a consented study or independently checked receipts.

For a real pilot, define denominators and a time window before collecting data: invited/consented participants, participants who started, completed economic flows, failed attempts, recoveries without resubmission, repeat participants and support minutes per completed task. Record the exact build/network and distinguish interface confusion, wallet rejection, liquidity failures, RPC failures and incorrect effects. Do not infer active users from imported archives or count duplicate plans as adoption.

## Interview outline

- Ask a wallet or DeFi operator to describe their last failed or confusing transaction, its financial/support cost, and their current workaround.
- Observe one swap and one vault exit without coaching. Capture where the minimum received, approval scope, fees or proof are misunderstood.
- Ask which evidence they would use to decide whether a transaction succeeded and whether the archive/recovery flow fits their existing support process.
- For an integrator, establish supported chains/venues, integration effort, required controls, acceptable failure behavior and who has budget authority. Ask what a paid pilot would have to demonstrate; do not treat interest as revenue.

## Positioning to validate

Hypothesis: users value a wallet-controlled execution workspace whose exact limits survive into a call and whose result can be independently checked; integrators may pay for SDK/support and an evidence workflow that reduces transaction-support cost. Validate willingness to adopt and pay before building a broad protocol marketplace, launching a token, or claiming a business model is proven.

The first external review should focus on the protected swap and full vault exit. A clear failure explanation and honest unknown status are stronger evidence than unsupported “safe yield” claims or an attractive APY card. Keep fundraising materials and event/video instructions out of the product interface.
