import dev from "../demo/devnode.json";
import { LocalNodeEvidence } from "../components/LocalNode";

const REPO = "https://github.com/rishu4436/seam-portaldot";
const CONSOLE = "./console.html";
const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

const seq = dev.sequential.run.receipt;

const PATH = [
  {
    n: "1",
    t: "Describe the transaction",
    d: "Pick the sample transfer, or fill in who receives what. That description is the Manifest.",
  },
  {
    n: "2",
    t: "SEAM checks it",
    d: "It reads the live Portaldot testnet, builds the exact call, and stops if your rules or the chain say no.",
  },
  {
    n: "3",
    t: "Your wallet signs",
    d: "SEAM never holds the key. If the chain result cannot be proven, the receipt says unknown.",
  },
];

export default function Landing() {
  return (
    <div className="lp">
      <header className="nav">
        <a className="brand" href="#top">
          <span className="logo">S</span>
          <b>SEAM</b>
        </a>
        <nav>
          <a href="#how">How it works</a>
          <a href="#try">Try it</a>
          <a className="btn small" href={CONSOLE}>
            Open the console
          </a>
        </nav>
      </header>

      <section className="hero" id="top">
        <div>
          <p className="eyebrow">Portaldot testnet</p>
          <h1>Check a transaction before your wallet signs it.</h1>
          <p className="lead">
            SEAM is a console for the Portaldot V3 testnet. You choose a transaction, SEAM checks it
            against the live chain, and your own wallet signs. A blocked check is a successful
            result.
          </p>
          <div className="cta">
            <a className="btn" href={CONSOLE}>
              Open the console
            </a>
            <a className="btn ghost" href="#try">
              See the three steps
            </a>
          </div>
          <p className="fine">
            Testnet only. Mainnet is refused. You need a Polkadot.js, Talisman, or SubWallet
            account, prefix 42, with testnet tPOT for fees.
          </p>
        </div>
        <aside className="receipt" aria-label="What the console walks you through">
          <header>
            <span>In the console</span>
            <b>3 steps</b>
          </header>
          <ol>
            <li>
              <span>Choose</span>
              <code>sample transfer or your own</code>
            </li>
            <li>
              <span>Check</span>
              <code>live V3 testnet</code>
            </li>
            <li>
              <span>Sign</span>
              <code>only if the check passes</code>
            </li>
          </ol>
          <footer>The console will not ask for a seed phrase.</footer>
        </aside>
      </section>

      <section id="how">
        <h2>How it works</h2>
        <p className="sec">One transaction. One check. One signature.</p>
        <ol className="steps">
          {PATH.map((p) => (
            <li key={p.n}>
              <span className="n">{p.n}</span>
              <h3>{p.t}</h3>
              <p>{p.d}</p>
            </li>
          ))}
        </ol>
      </section>

      <section id="try">
        <h2>Try it</h2>
        <p className="sec">Stay on the testnet. Do not deploy a contract.</p>
        <ol className="vol">
          <li>
            <span className="n">1</span>
            <p>
              <b>Install a wallet.</b> Polkadot.js, Talisman, or SubWallet. Create an account with
              ss58 prefix 42.
            </p>
          </li>
          <li>
            <span className="n">2</span>
            <p>
              <b>Open the console.</b> Connect the wallet, then press Check live. Stop if the chain
              is not <code>portaldot-v3</code>.
            </p>
          </li>
          <li>
            <span className="n">3</span>
            <p>
              <b>Send the sample, or build your own.</b> The sample moves 1 unit of test asset
              806707. Sign in the wallet only after the check says the plan is allowed. If it
              blocks, write down the code and <a href={`${REPO}/issues`}>open a GitHub issue</a>.
            </p>
          </li>
        </ol>
        <div className="cta" style={{ marginTop: 18 }}>
          <a className="btn" href={CONSOLE}>
            Open the console
          </a>
        </div>
      </section>

      <section id="more">
        <h2>Proof and source</h2>
        <p className="sec">
          The product above is the testnet console. The notes below are for someone checking the
          claims.
        </p>
        <details className="more">
          <summary>What has been shown on chain</summary>
          <p>
            The hosted V3 testnet (spec 3002) has a keystore run of 18 finalized transactions.
            Wallet-signed console proof so far is <code>assets.transfer</code>, including blocks
            #121390 and #121394. A Revive call with no <code>ContractEmitted</code> stays unknown.
            Nothing has been submitted to mainnet.
          </p>
          <p>
            A separate local dev chain recorded a three-step run as <b>{seq.result}</b> (
            {seq.coverage.verified} of {seq.coverage.expected} steps). That recording is not the V3
            testnet. First step {short(seq.steps[0].txHash)}. Files live in{" "}
            <a href={`${REPO}/tree/main/evidence/testnet-v3`}>evidence/testnet-v3</a>.
          </p>
        </details>
        <details className="more">
          <summary>Local node recording</summary>
          <LocalNodeEvidence />
        </details>
        <details className="more">
          <summary>Run it from the repo</summary>
          <pre>{`npm install
npm run build
npm run dev -w @seam/console`}</pre>
          <p>
            Needs Node 22 or later. The site is <code>http://localhost:5173</code>. The console is{" "}
            <code>http://localhost:5173/console.html</code>. Docs:{" "}
            <a href={`${REPO}/blob/main/docs/quickstart.md`}>quickstart</a>.
          </p>
        </details>
      </section>

      <footer>
        <div>
          <span className="logo">S</span> <b>SEAM</b>
          <span className="muted">Testnet console. Your wallet signs.</span>
        </div>
        <div>
          <a href={REPO}>GitHub</a> · <a href={CONSOLE}>Console</a>
        </div>
      </footer>
    </div>
  );
}
