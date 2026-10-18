import dev from "../demo/devnode.json";

const REPO = "https://github.com/rishu4436/seam-portaldot";
const CONSOLE = "./index.html";
const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

const PIPELINE = [
  { t: "Manifest", d: "One JSON file says what should happen. Its digest is the same on any machine." },
  { t: "Discover and lock", d: "SEAM reads the live runtime, fingerprints it and locks the plan to that fingerprint." },
  { t: "Compile", d: "Exact calls are built from the chain's own metadata. If the runtime lacks something, it says so." },
  { t: "Preflight and policy", d: "Fees, weight and dry runs are checked, then every allow-list and limit in your policy." },
  { t: "Approve and sign", d: "A human approval is bound to the plan. Your external wallet signs; SEAM never holds keys." },
  { t: "Finalize and verify", d: "A per-step submit gate, finalization tracking, then an Execution Receipt anyone can verify." },
];

const BLOCKS: [string, string][] = [
  ["signed_dry_run_failed", "The signed transaction failed its dry run, so it would fail on chain."],
  ["runtime_changed", "The chain's runtime changed after the plan was prepared. (Passes as runtime_unchanged when it didn't.)"],
  ["message_not_allowed", "The contract message isn't in the policy's allowed list, or the call is raw data with no message name."],
  ["abi_hash_missing", "The policy pins an interface hash for this contract, but the call carries none."],
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

const QUICK = [
  { c: "npm install\nnpm run build\nnpm test", n: "Needs Node 22 or later. Run from the repo root." },
  { c: "npx seam digest docs/examples/demo-manifest.json\nnpx seam compile docs/examples/demo-manifest.json\nnpx seam check docs/examples/demo-manifest.json --policy docs/examples/strict-policy.json", n: "Offline, against the bundled read-only Portaldot mainnet snapshot. The last command is expected to block: amount over limit." },
  { c: "npm run test:e2e", n: "Runs the whole flow on a throwaway local dev chain (not Portaldot). Downloads the node binary the first time." },
  { c: "npm run dev -w @seam/console", n: "Opens the console on http://localhost:5173." },
];

export default function Landing() {
  return (
    <div className="lp">
      <header className="nav">
        <a className="brand" href="#top"><span className="logo">S</span><b>SEAM</b></a>
        <nav>
          <a href="#pipeline">Pipeline</a><a href="#blocks">What it blocks</a><a href="#proof">Proof</a><a href="#dev">Developers</a>
          <a className="btn small" href={CONSOLE}>Open the console</a>
        </nav>
      </header>

      <section className="hero" id="top">
        <p className="eyebrow">Portaldot Hacker House 2026 · Modular Cloud &amp; Middleware</p>
        <h1>One Manifest in.<br />A verified receipt out.</h1>
        <p className="lead">SEAM is the developer execution layer for Portaldot. Describe what should happen once; SEAM compiles it from the live runtime, checks it against your policy, gets it signed by your own wallet, and proves what actually landed on chain.</p>
        <div className="cta">
          <a className="btn" href={CONSOLE}>Open the console</a>
          <a className="btn ghost" href={REPO}>View the repo</a>
        </div>
        <p className="fine">Today the recorded runs are on a local test chain, not Portaldot. <a href="#proof">See exactly what is proven.</a></p>
      </section>

      <section id="pipeline">
        <h2>The pipeline</h2>
        <p className="sec">Six stages from intent to proof. Each one can stop the run, and says why in plain English.</p>
        <ol className="steps">
          {PIPELINE.map((p, i) => (
            <li key={p.t}><span className="n">{i + 1}</span><h3>{p.t}</h3><p>{p.d}</p></li>
          ))}
        </ol>
      </section>

      <section id="blocks">
        <h2>What it blocks</h2>
        <p className="sec">The submit gate runs before every step is sent. Anything not allowed, and anything that can't be confirmed, is refused. These are the real block codes from <a href={`${REPO}/blob/main/docs/reference.md`}>docs/reference.md</a>.</p>
        <div className="codes">
          {BLOCKS.map(([c, d]) => (<div className="code" key={c}><code>{c}</code><p>{d}</p></div>))}
        </div>
      </section>

      <section id="proof">
        <h2>Proof from recorded runs</h2>
        <div className="warn">
          <b>Local test chain, not Portaldot.</b> Every run below was recorded on a local <code>substrate-contracts-node</code> v0.42.0 dev chain (spec 100, metadata V14), signed with the public dev account. Nothing was submitted to Portaldot. Portaldot mainnet is only read, from a snapshot. Portaldot V3 testnet runs do not exist yet.
        </div>
        <div className="proofgrid">
          <article>
            <h3>Sequential: transfer, <code>settle</code> contract call, mint</h3>
            <p>Three steps, one transaction each, with a gate check before every send. Receipt: <b>{seq.result}</b>, {seq.coverage.verified} of {seq.coverage.expected} steps confirmed.</p>
            <ul className="tx">{seq.steps.map((s: any) => (<li key={s.actionId}><b>{s.actionId}</b> block #{s.block.number} <code title={s.txHash}>{short(s.txHash)}</code></li>))}</ul>
          </article>
          <article>
            <h3>Atomic: one <code>batch_all</code></h3>
            <p>The same three steps in a single transaction, used only because rollback was proven on this runtime. Receipt: <b>{ato.result}</b>, {ato.coverage.verified} of {ato.coverage.expected} steps confirmed.</p>
            <ul className="tx"><li>block #{ato.steps[0].block.number} <code title={ato.steps[0].txHash}>{short(ato.steps[0].txHash)}</code></li></ul>
          </article>
          <article>
            <h3>Rollback costs only the fee</h3>
            <p>A <code>batch_all</code> whose step 2 overdraws was <b>blocked by the gate</b> (<code>signed_dry_run_failed</code>). Sent anyway as a test-only bypass, it failed as a whole: no inner events, asset balances and supply unchanged, only the fee charged.</p>
            <ul className="tx"><li>bypass block #{rb.directSubmit.block.number} <code title={rb.directSubmit.txHash}>{short(rb.directSubmit.txHash)}</code></li></ul>
          </article>
        </div>
        <p className="fine">Recordings: <code>{dev.sequential.evidenceFile.split("/").pop()}</code>, <code>{dev.atomic.evidenceFile.split("/").pop()}</code>, <code>{dev.rollback.evidenceFile.split("/").pop()}</code> in <a href={`${REPO}/tree/main/evidence`}>evidence/</a>. Not shown: behaviour of Portaldot's V3 runtime, or a run signed in a real browser wallet.</p>
        <div className="placeholder">
          <b>PLACEHOLDER · Portaldot V3 testnet</b>
          <p>Transaction hashes and contract addresses will go here once the V3 testnet RPC and faucet are available. None exist yet, and none are shown. Steps: <a href={`${REPO}/blob/main/docs/testnet-checklist.md`}>docs/testnet-checklist.md</a>.</p>
          <code>testnet tx hashes: (pending)</code>
        </div>
      </section>

      <section id="dev">
        <h2>For developers</h2>
        <p className="sec">From the repo's own quickstart. The <code>seam</code> CLI and SDK ship in the same repo; see <a href={`${REPO}/blob/main/docs/quickstart.md`}>docs/quickstart.md</a> and <a href={`${REPO}/blob/main/docs/reference.md`}>docs/reference.md</a>.</p>
        <div className="quick">
          {QUICK.map((q, i) => (<div key={i}><pre>{q.c}</pre><p>{q.n}</p></div>))}
        </div>
      </section>

      <footer>
        <div><span className="logo">S</span> <b>SEAM</b> <span className="muted">Built for Portaldot Hacker House 2026</span></div>
        <div><a href={REPO}>github.com/rishu4436/seam-portaldot</a> · <a href={CONSOLE}>Console</a></div>
      </footer>
    </div>
  );
}
