import { useEffect, useState } from "react";

export function ReadProgress({ active, label }: { active: boolean; label: string }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    setSeconds(0);
    if (!active) return;
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [active]);
  if (!active) return null;
  return (
    <p className="read-progress" role="status" aria-live="polite">
      <strong>{label}</strong> · {seconds}s
      <span>
        {seconds >= 10
          ? "The network is taking longer to respond. This check does not request a signature."
          : "Reading live chain data. This check does not request a signature."}
      </span>
    </p>
  );
}
