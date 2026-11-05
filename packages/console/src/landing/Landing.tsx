import { SeamMark, Symbol } from "../components/Brand";
import { SOURCE_URL } from "../lib/product-links";
const steps = [
  {
    n: "01",
    title: "Describe your intent.",
    text: "Choose your account, destination and action. Build a single transaction or a sequence of actions.",
    icon: "layers" as const,
  },
  {
    n: "02",
    title: "See the checks.",
    text: "SEAM reads the live runtime, compiles exact calls and checks your recipients, amounts and fee limits.",
    icon: "shield" as const,
  },
  {
    n: "03",
    title: "Sign with confidence.",
    text: "Your wallet signs the approved transaction. A finalized receipt records what the chain actually proves.",
    icon: "wallet" as const,
  },
];
export default function Landing() {
  return (
    <div className="site">
      <header className="site-nav">
        <a className="site-brand" href="#top">
          <span>
            <SeamMark />
          </span>
          seam.
        </a>
        <nav aria-label="Main navigation">
          <a href="#how">How it works</a>
          <a href="#principles">Why SEAM</a>
          <a href="./console.html?view=defi">Swap & vaults</a>
          <a href="./console.html?view=developers">
            Developers <Symbol kind="external" />
          </a>
        </nav>
        <a className="site-button small" href="./console.html">
          Launch workspace <Symbol kind="arrow" />
        </a>
      </header>
      <main>
        <section className="site-hero" id="top">
          <div className="hero-copy">
            <span className="site-network">
              <i />
              BUILT FOR PORTALDOT V3 TESTNET
            </span>
            <h1>
              Your intent.
              <br />
              Every check.
              <br />
              <span>One clear outcome.</span>
            </h1>
            <p>
              Move from a transaction idea to a verified result.
              <br className="desktop-break" /> SEAM brings runtime checks, policy and wallet signing
              <br className="desktop-break" /> into one focused workspace.
            </p>
            <div className="hero-actions">
              <a className="site-button" href="./console.html">
                Open the live workspace <Symbol kind="arrow" />
              </a>
              <a className="text-link" href="./console.html?view=defi">
                Explore swaps & vaults <span>↗</span>
              </a>
            </div>
            <div className="hero-footnote">
              <Symbol kind="shield" />
              <span>Your wallet. Your keys. Your approval.</span>
            </div>
          </div>
          <div
            className="flow-art"
            aria-label="Transaction flow illustration, not live transaction data"
          >
            <div className="art-grid" />
            <span className="art-caption">A CLEAR PATH FROM INTENT TO RESULT</span>
            <div className="orb orb-one" />
            <div className="orb orb-two" />
            <svg className="flow-line" viewBox="0 0 500 530" fill="none" aria-hidden="true">
              <path d="M250 100V180H140V280H355V385H250V460" stroke="#dcd9f0" strokeWidth="2" />
              <path
                className="travelling-line"
                d="M250 100V180H140V280H355V385H250V460"
                stroke="#8d82df"
                strokeWidth="3"
                strokeDasharray="14 700"
              />
            </svg>
            <div className="art-card intent-card">
              <span className="art-icon">
                <Symbol kind="layers" />
              </span>
              <div>
                <small>START WITH AN INTENT</small>
                <b>Your transaction</b>
              </div>
              <span className="art-token">01</span>
            </div>
            <div className="art-card check-card">
              <span className="art-icon violet">
                <Symbol kind="shield" />
              </span>
              <div>
                <small>BEFORE THE SIGNATURE</small>
                <b>Live runtime + policy</b>
                <p>
                  <i />
                  Call bytes <i />
                  Limits <i />
                  Fees
                </p>
              </div>
            </div>
            <div className="art-card result-card">
              <span className="art-icon green">
                <Symbol kind="wallet" />
              </span>
              <div>
                <small>YOUR WALLET SIGNS</small>
                <b>Verify the finalized result</b>
              </div>
              <span className="art-arrow">↗</span>
            </div>
            <div className="art-bottom">
              <span>COMPILE</span>
              <span>CHECK</span>
              <span>SIGN</span>
              <span>VERIFY</span>
            </div>
          </div>
        </section>
        <div className="site-strip">
          <span>
            One execution layer.<b>Every step accounted for.</b>
          </span>
          <div>
            <span>
              <Symbol kind="layers" />
              Metadata-driven calls
            </span>
            <span>
              <Symbol kind="shield" />
              Policy before signing
            </span>
            <span>
              <Symbol kind="wallet" />
              External wallet custody
            </span>
          </div>
        </div>
        <section className="site-how" id="how">
          <div className="site-section-head">
            <p className="site-eyebrow">LESS GUESSWORK. MORE CLARITY.</p>
            <h2>
              Complex execution.
              <br />
              <span>A straightforward experience.</span>
            </h2>
            <p>You bring the intent. SEAM makes the path visible.</p>
          </div>
          <ol className="site-step-grid">
            {steps.map((s) => (
              <li key={s.n}>
                <div className="step-top">
                  <span>{s.n}</span>
                  <Symbol kind={s.icon} />
                </div>
                <h3>{s.title}</h3>
                <p>{s.text}</p>
                <div className="step-line" />
              </li>
            ))}
          </ol>
        </section>
        <section className="site-principles" id="principles">
          <div>
            <p className="site-eyebrow">A WORKSPACE YOU CAN REASON ABOUT</p>
            <h2>
              Clarity at every
              <br />
              trust boundary.
            </h2>
            <p>
              A successful dispatch is only part of the story.
              <br />
              SEAM keeps approval, finality and proven effects distinct.
            </p>
            <a
              className="text-link"
              href="https://github.com/rishu4436/seam-portaldot/blob/main/docs/SECURITY_GATES.md"
              target="_blank"
              rel="noreferrer"
            >
              Understand the checks <Symbol kind="arrow" />
            </a>
          </div>
          <div className="principle-list">
            <article>
              <span>01</span>
              <div>
                <h3>Built from the live runtime</h3>
                <p>
                  Calls are compiled from metadata. If an action is unavailable, the workspace tells
                  you before you sign.
                </p>
              </div>
            </article>
            <article>
              <span>02</span>
              <div>
                <h3>Your approval has boundaries</h3>
                <p>
                  Approvals bind the plan, policy and signing window. Changes require another
                  review.
                </p>
              </div>
            </article>
            <article>
              <span>03</span>
              <div>
                <h3>Proof, with its limits visible</h3>
                <p>
                  Finalized and verified mean different things. An effect the chain cannot prove
                  stays unknown.
                </p>
              </div>
            </article>
          </div>
        </section>
        <section className="site-start">
          <div>
            <span className="site-eyebrow">YOUR NEXT TRANSACTION STARTS HERE</span>
            <h2>
              Make a move.
              <br />
              Know what happens.
            </h2>
            <p>Connect a Polkadot-compatible wallet and use testnet tPOT for fees.</p>
          </div>
          <a className="site-button" href="./console.html">
            Enter the workspace <Symbol kind="arrow" />
          </a>
          <div className="start-orbit" aria-hidden="true" />
        </section>
      </main>
      <footer className="site-footer">
        <a className="site-brand" href="#top">
          <span>
            <SeamMark />
          </span>
          seam.
        </a>
        <p>Execution infrastructure for Portaldot.</p>
        <div>
          <span>
            <i />
            V3 testnet only
          </span>
          <a href={SOURCE_URL} target="_blank" rel="noreferrer">
            Source code ↗
          </a>
        </div>
      </footer>
    </div>
  );
}
