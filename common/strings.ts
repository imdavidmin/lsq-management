// Display-string helpers shared by server and web. Dependency-free.

// Abbreviations kept upper-case when a key is turned into a label.
const ACRONYMS = new Set(["sla", "hiu"]);

export const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// 'con.hiu_servicing' → 'HIU servicing': drop the domain prefix, sentence-case the rest.
export function metricLabel(key: string): string {
  const words = key.slice(key.indexOf(".") + 1).split("_");
  return capitalise(words.map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w)).join(" "));
}
