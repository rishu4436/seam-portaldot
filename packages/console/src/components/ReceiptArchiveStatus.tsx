import { useEffect, useState } from "react";
import { saveLocalReceipt } from "../lib/receiptarchive";

/** Receipt persistence is separate from the execution journal and can never release a send guard. */
export function ReceiptArchiveStatus({
  receipt,
  manifest,
}: {
  receipt: unknown;
  manifest?: unknown;
}) {
  const serialized = JSON.stringify(
    manifest ? { receipt, manifest, plan: (receipt as { plan?: unknown }).plan } : receipt,
  );
  const [message, setMessage] = useState("Saving receipt in this browser…");
  useEffect(() => {
    let active = true;
    setMessage("Saving receipt in this browser…");
    void saveLocalReceipt(JSON.parse(serialized))
      .then(() => {
        if (active)
          setMessage(
            "Receipt saved in this browser. Recover it from Activity & recovery after refreshing.",
          );
      })
      .catch((error: unknown) => {
        if (active)
          setMessage(
            `Receipt not saved locally: ${error instanceof Error ? error.message : String(error)}`,
          );
      });
    return () => {
      active = false;
    };
  }, [serialized]);
  return (
    <p role="status" className="workspace-notice">
      {message}
    </p>
  );
}
