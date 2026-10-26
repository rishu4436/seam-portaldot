import { EVIDENCE_LABEL, type EvidenceLabel, type ProofRow } from "../lib/statuslabels";

export function StatusLabel({ label }: { label: EvidenceLabel }) {
  const l = EVIDENCE_LABEL[label];
  return (
    <span className={`badge ${l.tone}`} data-label={label} title={l.meaning}>
      {l.text}
    </span>
  );
}

/** One view, five proof rows: fee estimate, unsigned sim, signed dry run, dispatch result, verified effect. */
export function ProofRows({ rows }: { rows: ProofRow[] }) {
  return (
    <div role="group" aria-label="Proof">
      <table className="kv">
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} data-testid={`proof-${r.id}`}>
              <th scope="row">{r.title}</th>
              <td>
                <StatusLabel label={r.label} />
              </td>
              <td className="muted">{r.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
