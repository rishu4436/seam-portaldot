import dev from "../demo/devnode.json";

import { LocalNodeBanner, LocalNodeEvidence } from "../components/LocalNode";

const REPO = "https://github.com/rishu4436/seam-portaldot";
const CONSOLE = "./index.html";
const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

const PIPELINE = [
  {
    t: "Manifest",
    d: "One JSON file says what should happen. Its digest is the same on any machine.",
  },
  {
    t: "Discover and lock",
    d: "SEAM reads the live runtime, fingerprints it and locks the plan to that fingerprint.",
  },
  {
    t: "Compile",
    d: "Exact calls are built from the chain's own metadata. If the runtime lacks something, it says so.",
  },
  {
    t: "Preflight and policy",
    d: "Fees, weight and dry runs are checked, then every allow-list and limit in your policy.",
  },
  {
    t: "Approve and sign",
    d: "A human approval is bound to the plan. Your external wallet signs; SEAM never holds keys.",
  },
  {
    t: "Finalize and verify",
    d: "A per-step submit gate, finalization tracking, then an Execution Receipt anyone can verify.",
  },
];

const BLOCKS: [string, string][] = [
  [
    "signed_dry_run_failed",
    "The signed transaction failed its dry run, so it would fail on chain.",
  ],
  [
    "runtime_changed",
    "The chain's runtime changed after the plan was prepared. (Passes as runtime_unchanged when it didn't.)",
  ],
  [
    "message_not_allowed",
    "The contract message isn't in the policy's allowed list, or the call is raw data with no message name.",
  ],
  [
    "abi_hash_missing",
    "The policy pins an interface hash for this contract, but the call carries none.",
  ],
  ["abi_hash_mismatch", "The call's interface hash differs from the one pinned for this contract."],
  ["signed_bytes_mismatch", "The wallet signed different call data from the approved plan."],
  ["approval_reused", "This approval, or this step of it, was already sent."],
  ["approval_expired", "The approval is past its expiry."],
  ["approval_tampered", "The approval's contents don't match its hash."],
  ["out_of_order", "A sequential step was sent before the one before it."],
];

const seq = dev.sequential.run.receipt;
const ato = dev.atomic.run.receipt;
const rb = dev.rollback;

const EXAMPLE = `{
  "version": 1,
  "signer": { "type": "ss58", "value": "<your address>", "ss58Prefix": 42 },
  "actions": [
    { "id": "pay", "kind": "assets.transfer",
      "args": { "assetId": "1", "amount": "2500", "recipient": "<recipient>" } }
  ]
}`;

const QUICK = [
  {
    c: "npm install\nnpm run build\nnpm test",
    n: "Needs Node 22 or later. Run from the repo root.",
  },
  {
    c: "npx seam digest docs/examples/demo-manifest.json\nnpx seam compile docs/examples/demo-manifest.json\nnpx seam check docs/examples/demo-manifest.json --policy docs/examples/strict-policy.json",
    n: "Offline, against the bundled read-only Portaldot mainnet snapshot. The last command is expected to block: amount over limit.",
  },
  {
    c: "npm run test:e2e",
    n: "Runs the whole flow on a throwaway local dev chain (not Portaldot). Downloads the node binary the first time.",
  },
  {
    c: "npm run dev -w @seam/console",
    n: "Opens the console on http://localhost:5173. The hosted site opens on this product page. The console is index.html.",
  },
];

export default function Landing() {
  return (
    <div className="lp">
      <LocalNodeBanner />
      <header className="nav">
        <a className="brand" href="#top">
          <span className="logo">S</span>
          <b>SEAM</b>
        </a>
        <nav>
          <a href="#pipeline">Pipeline</a>
          <a href="#volunteers">Test it</a>
          <a href="#blocks">What it blocks</a>
          <a href="#proof">Proof</a>
          <a href="#dev">Developers</a>
          <a className="btn small" href={CONSOLE}>
            Open the console
          </a>
        </nav>
      </header>

      <section className="hero" id="top">
        <div>
          <p className="eyebrow">Execution layer for Portaldot</p>
          <h1>One Manifest in. A verified receipt out.</h1>
          <p className="lead">
            Write what should happen. SEAM compiles the exact calls from the chain's own metadata,
            checks them against a policy, and asks your wallet to sign. It never holds keys. If an
            effect cannot be proven, the receipt stays unknown.
          </p>
          <div className="cta">
            <a className="btn" href={CONSOLE}>
              Open the console
            </a>
            <a className="btn ghost" href="#volunteers">
              Volunteer test guide
            </a>
          </div>
          <p className="fine">
            Hosted V3 testnet, spec 3002. Offline verify checks that a receipt was not edited. It is
            not chain proof. <a href="#proof">See exactly what is proven.</a>
          </p>
        </div>
        <aside className="receipt" aria-label="Recorded local receipt, not a live balance">
          <header>
            <span>Recorded receipt</span>
            <b>{seq.result}</b>
          </header>
          <ol>
            {seq.steps.map((s: { actionId: string; block: { number: number }; txHash: string }) => (
              <li key={s.actionId}>
                <span>{s.actionId}</span>
                <code>
                  #{s.block.number} {short(s.txHash)}
                </code>
              </li>
            ))}
          </ol>
          <footer>
            Local dev-chain recording. {seq.coverage.verified} of {seq.coverage.expected} steps
            confirmed. This card is not the V3 testnet.
          </footer>
        </aside>
      </section>

      <div className="stats" aria-label="What has been shown">
        <div>
          <b>spec 3002</b>
          <span>Hosted V3 testnet the console reads</span>
        </div>
        <div>
          <b>18 txs</b>
          <span>Finalized keystore run, with evidence files</span>
        </div>
        <div>
          <b>Transfers</b>
          <span>Extension-signed console proof so far</span>
        </div>
        <div>
          <b>No keys</b>
          <span>Your wallet signs. SEAM only prepares the call</span>
        </div>
      </div>

      <section id="pipeline">
        <h2>The pipeline</h2>
        <p className="sec">
          Six stages from intent to proof. Each one can stop the run, and says why in plain English.
        </p>
        <ol className="steps">
          {PIPELINE.map((p, i) => (
            <li key={p.t}>
              <span className="n">{i + 1}</span>
              <h3>{p.t}</h3>
              <p>{p.d}</p>
            </li>
          ))}
        </ol>
      </section>

      <section id="volunteers">
        <h2>Test it with five or six people</h2>
        <p className="sec">
          The console talks to the hosted Portaldot V3 testnet. A blocked plan is a successful
          test. Report the block code, not only whether a transaction landed.
        </p>
        <ol className="vol">
          <li>
            <span className="n">1</span>
            <p>
              <b>Install a Substrate wallet.</b> Polkadot.js, Talisman, or SubWallet. Create an
              account. Portaldot V3 uses ss58 prefix 42.
            </p>
          </li>
          <li>
            <span className="n">2</span>
            <p>
              <b>Open the console and connect.</b> Connect the wallet, then connect to the node.
              The default endpoint is the hosted V3 testnet over HTTPS. Read live facts. Stop if
              the runtime is not <code>portaldot-v3</code> spec 3002.
            </p>
          </li>
          <li>
            <span className="n">3</span>
            <p>
              <b>You need testnet tPOT for fees.</b> A zero balance cannot sign. Ask the team for
              faucet funds. tPOT has no mainnet value. Do not deploy a contract: the deposit on
              this runtime is not refunded.
            </p>
          </li>
          <li>
            <span className="n">4</span>
            <p>
              <b>Run the wallet demo, or build a plan.</b> The demo sends 1 unit of test asset
              806707 under a strict policy. A custom plan is checked before the wallet opens.
              Approve only when the gate says the plan is allowed.
            </p>
          </li>
          <li>
            <span className="n">5</span>
            <p>
              <b>Confirm in your wallet, then verify the receipt.</b> SEAM never sees the key.
              Download the receipt and paste it into Verify a receipt. That check is integrity
              only. Chain proof is a finalized transaction.
            </p>
          </li>
          <li>
            <span className="n">6</span>
            <p>
              <b>Write down what you saw.</b> Wallet name, the screen you stopped on, the block
              code if one appeared, and whether the receipt downloaded. File it on{" "}
              <a href={`${REPO}/issues`}>GitHub issues</a>.
            </p>
          </li>
        </ol>
        <div className="note-grid">
          <article className="do">
            <h3>Worth trying</h3>
            <ul>
              <li>Connect, disconnect, and connect a second account.</li>
              <li>A plan the policy should block, such as a recipient that is not allowed.</li>
              <li>Reject the wallet prompt and confirm nothing was sent.</li>
              <li>Refresh during a run and see whether the approval can be reconciled.</li>
            </ul>
          </article>
          <article className="dont">
            <h3>Leave these alone</h3>
            <ul>
              <li>Mainnet. SEAM has only read an old snapshot. Do not point this at mainnet funds.</li>
              <li>Contract deploy and <code>revive.instantiate_with_code</code>. The deposit stays locked.</li>
              <li>Any plan you cannot read. Unknown is not success.</li>
            </ul>
          </article>
        </div>
      </section>

      <section id="blocks">
        <h2>What it blocks</h2>
        <p className="sec">
          The submit gate runs before every step is sent. Anything not allowed, and anything that
          can't be confirmed, is refused. These are the real block codes from{" "}
          <a href={`${REPO}/blob/main/docs/reference.md`}>docs/reference.md</a>.
        </p>
        <div className="codes">
          {BLOCKS.map(([c, d]) => (
            <div className="code" key={c}>
              <code>{c}</code>
              <p>{d}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="local-node">
        <h2>Real run on a local Portaldot node</h2>
        <p className="sec">
          Recorded from the organizers' own node binary, copied from{" "}
          <a href={`${REPO}/tree/main/evidence/portaldot-local-node`}>
            evidence/portaldot-local-node/
          </a>
          .
        </p>
        <LocalNodeEvidence />
      </section>

      <section id="proof">
        <h2>Proof from recorded runs</h2>
        <div className="warn">
          <b>What is proven, and what is not.</b> The hosted Portaldot V3 testnet (spec 3002) has a
          funded keystore run of 18 finalized transactions, plus later console runs signed with the
          polkadot.js extension. Extension proof today is <code>assets.transfer</code> only,
          including the 2-step sequential run at blocks #121390 and #121394. A per-call Revive
          effect without <code>ContractEmitted</code> stays unknown. A fresh account mapping, ink!
          on V3, and cross-VM atomicity are not proven. Mainnet was only read (snapshot at block
          2,721,455, spec 1002). Nothing has been submitted to mainnet. The local-chain recordings
          below are a separate dev chain and do not prove V3.
        </div>
        <div className="proofgrid">
          <article>
            <h3>
              Sequential: transfer, <code>settle</code> contract call, mint
            </h3>
            <p>
              Three steps, one transaction each, with a gate check before every send. Receipt:{" "}
              <b>{seq.result}</b>, {seq.coverage.verified} of {seq.coverage.expected} steps
              confirmed.
            </p>
            <ul className="tx">
              {seq.steps.map((s: any) => (
                <li key={s.actionId}>
                  <b>{s.actionId}</b> block #{s.block.number}{" "}
                  <code title={s.txHash}>{short(s.txHash)}</code>
                </li>
              ))}
            </ul>
          </article>
          <article>
            <h3>
              Atomic: one <code>batch_all</code>
            </h3>
            <p>
              The same three steps in a single transaction, used only because rollback was proven on
              this runtime. Receipt: <b>{ato.result}</b>, {ato.coverage.verified} of{" "}
              {ato.coverage.expected} steps confirmed.
            </p>
            <ul className="tx">
              <li>
                block #{ato.steps[0].block.number}{" "}
                <code title={ato.steps[0].txHash}>{short(ato.steps[0].txHash)}</code>
              </li>
            </ul>
          </article>
          <article>
            <h3>Rollback costs only the fee</h3>
            <p>
              A <code>batch_all</code> whose step 2 overdraws was <b>blocked by the gate</b> (
              <code>signed_dry_run_failed</code>). Sent anyway as a test-only bypass, it failed as a
              whole: no inner events, asset balances and supply unchanged, only the fee charged.
            </p>
            <ul className="tx">
              <li>
                bypass block #{rb.directSubmit.block.number}{" "}
                <code title={rb.directSubmit.txHash}>{short(rb.directSubmit.txHash)}</code>
              </li>
            </ul>
          </article>
        </div>
        <p className="fine">
          Local recordings: <code>{dev.sequential.evidenceFile.split("/").pop()}</code>,{" "}
          <code>{dev.atomic.evidenceFile.split("/").pop()}</code>,{" "}
          <code>{dev.rollback.evidenceFile.split("/").pop()}</code>. V3 evidence, including #118310
          and #121390/#121394, is in{" "}
          <a href={`${REPO}/tree/main/evidence/testnet-v3`}>evidence/testnet-v3</a>. The compiler
          encodes seven kinds when the metadata shape matches: assets transfer and mint, an ink!
          call, an NFT mint, and Revive call, deploy, and account mapping. Fee-in-asset,{" "}
          <code>nfts.create</code>, proxy, and multisig are not encoded.
        </p>
      </section>

      <section id="dev">
        <h2>For developers</h2>
        <p className="sec">
          From the repo's own quickstart. The <code>seam</code> CLI and SDK ship in the same repo;
          see <a href={`${REPO}/blob/main/docs/quickstart.md`}>docs/quickstart.md</a> and{" "}
          <a href={`${REPO}/blob/main/docs/reference.md`}>docs/reference.md</a>.
        </p>
        <div className="quick">
          <div>
            <pre>{EXAMPLE}</pre>
            <p>
              A minimal manifest: one action, a typed signer. Save it as{" "}
              <code>my-manifest.json</code>, then run <code>npx seam digest my-manifest.json</code>{" "}
              and <code>npx seam compile my-manifest.json</code> (same CLI as below). Full shape:{" "}
              <code>docs/examples/demo-manifest.json</code>.
            </p>
          </div>
          {QUICK.map((q, i) => (
            <div key={i}>
              <pre>{q.c}</pre>
              <p>{q.n}</p>
            </div>
          ))}
        </div>
      </section>

      <footer>
        <div>
          <span className="logo">S</span> <b>SEAM</b>{" "}
          <span className="muted">Manifest in, verified receipt out. SEAM never holds keys.</span>
        </div>
        <div>
          <a href={REPO}>github.com/rishu4436/seam-portaldot</a> · <a href={CONSOLE}>Console</a>
        </div>
      </footer>
    </div>
  );
}
