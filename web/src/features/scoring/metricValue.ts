import type { Metric } from "../../api/types";
import { pct } from "../../lib/format";

// How a value is entered: pass/fail, a percentage (stored 0..1), a survey rating, or a count.
export type Kind = "passfail" | "percent" | "rating" | "count";
export const kindOf = (m: Metric): Kind =>
  m.mode === "proportional"
    ? "percent"
    : m.source === "survey"
      ? "rating"
      : m.threshold == null
        ? "passfail"
        : "count";

export const formatValue = (m: Metric | undefined, v: number | null | undefined) => {
  if (v == null) return "—";
  if (!m) return String(v);
  const kind = kindOf(m);
  return kind === "passfail" ? (v >= 1 ? "Met" : "Not met") : kind === "percent" ? pct(v) : String(v);
};
