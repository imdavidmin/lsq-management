// Display helpers. Scoring ratios are 0..1; show as whole-percent.
export const pct = (ratio: number | null | undefined): string =>
  ratio == null ? "—" : `${Math.round(ratio * 100)}%`;

export const date = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleDateString() : "—";

export const dateTime = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleString() : "—";

const RTF = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31536000], ["month", 2592000], ["week", 604800],
  ["day", 86400], ["hour", 3600], ["minute", 60], ["second", 1],
];

// "3 days ago", "just now" — Intl.RelativeTimeFormat, no dependency.
export const relativeTime = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const secs = (new Date(iso).getTime() - Date.now()) / 1000;
  for (const [unit, s] of UNITS) {
    if (Math.abs(secs) >= s || unit === "second") return RTF.format(Math.round(secs / s), unit);
  }
  return "—";
};
