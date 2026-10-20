import { V3_EVIDENCE, rowViews, shortHash } from "../lib/v3evidence";
import "./v3evidence.css";

/** Real Portaldot V3 testnet transactions, replayed from the committed evidence (not fetched live). */
export function V3Evidence() {
  const rows = V3_EVIDENCE.rows;
  const sent = rows.filter((r) => r.txHash && r.finalized).length;
  return (
    <section className="card v3ev" aria-labelledby="v3ev-h" id="v3-evidence">
      <h3 id="v3ev-h">V3 testnet transactions (recorded)</h3>
      <p className="muted small">
        {sent} finalized transactions on {V3_EVIDENCE.chain} (spec {V3_EVIDENCE.specVersion}), from{" "}
        <code>evidence/testnet-v3</code>. This list is a recording, not a live read. The receipt
        column shows exactly what SEAM's recorded receipt says; "unknown" means SEAM did not prove
        the effect. Where a record has a later receipt built with the nfts verdict, that one is
        shown and labelled. Each receipt is tied to the fingerprint its run recorded; it is not
        re-checked against today's live fingerprint, which differs only because V3 metadata drifts
        (one storage default), not because of a runtime upgrade.
      </p>
      <div className="tw">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Step</th>
              <th>Tx hash</th>
              <th>Block</th>
              <th>Chain outcome</th>
              <th>SEAM receipt</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.id}</td>
                <td>{r.step}</td>
                <td>
                  <code title={r.txHash ?? undefined}>{shortHash(r.txHash)}</code>
                </td>
                <td>
                  {r.block != null && r.explorer ? (
                    <a href={r.explorer} target="_blank" rel="noreferrer noopener">
                      #{r.block}
                    </a>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="small">{r.chainOutcome}</td>
                <td>
                  {r.receipt.kind === "receipt" && (
                    <div className="muted small">
                      Shown: <code>{r.receipt.shown}</code>, result {r.receipt.result}, recorded
                      fingerprint <code>{r.receipt.fingerprintDigest.slice(0, 10)}…</code>
                    </div>
                  )}
                  {rowViews(r).map((v) => (
                    <div key={v.actionId} className="small">
                      <span className={`pill ${v.tone}`}>
                        {v.actionId !== "-" && <b>{v.actionId}: </b>}
                        {v.text}
                      </span>
                      {v.note && <div className="muted">{v.note}</div>}
                    </div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">
        Explorer links open the block in the Portaldot Node Console; you may need to point it at the
        V3 node first.
      </p>
    </section>
  );
}
