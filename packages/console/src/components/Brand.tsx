export function SeamMark() {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path d="M7 7h18v6H13v6h12v6H7v-6h12v-6H7z" fill="currentColor" />
    </svg>
  );
}
export function Symbol({
  kind,
}: {
  kind: "arrow" | "shield" | "wallet" | "layers" | "external" | "activity";
}) {
  const paths = {
    arrow: "M5 12h14m-5-5 5 5-5 5",
    shield: "M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6z M8 12l3 3 5-6",
    wallet: "M4 7V5h14v3M3 8h18v12H3z M16 12h5v4h-5z",
    layers: "m12 3 9 5-9 5-9-5z M3 12l9 5 9-5 M3 16l9 5 9-5",
    external: "M14 4h6v6 M20 4 10 14 M10 4H4v16h16v-6",
    activity: "M3 12h4l3-8 4 16 3-8h4",
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[kind]} />
    </svg>
  );
}
