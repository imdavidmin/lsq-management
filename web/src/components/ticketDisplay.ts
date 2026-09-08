import { tokens } from "@fluentui/react-components";
import type { Event } from "../api/types";

// Single source of truth lives on the server; imported across the workspace so
// the two lists can't drift. A dropdown of these avoids typos; unknown stored
// values still display (see the editor).
export { CATEGORIES } from "../../../common/tickets";

// Arbitrary category → colour band (Fluent palette tints); neutral fallback.
const CATEGORY: Record<string, { bg: string; fg: string }> = {
  site_defect: { bg: tokens.colorPaletteBerryBackground2, fg: tokens.colorPaletteBerryForeground2 },
  cleaning: { bg: tokens.colorPaletteGreenBackground2, fg: tokens.colorPaletteGreenForeground2 },
  reactive_fault: { bg: tokens.colorPaletteMarigoldBackground2, fg: tokens.colorPaletteMarigoldForeground2 },
  communication: { bg: tokens.colorPaletteBlueBackground2, fg: tokens.colorPaletteBlueForeground2 },
};

// Actor role → header shade for comment rows. Neutral fallback (e.g. system).
const ROLE: Record<string, { bg: string; fg: string }> = {
  resident: { bg: tokens.colorPaletteBlueBackground2, fg: tokens.colorPaletteBlueForeground2 },
  board: { bg: tokens.colorPaletteBerryBackground2, fg: tokens.colorPaletteBerryForeground2 },
  agent: { bg: tokens.colorPaletteGreenBackground2, fg: tokens.colorPaletteGreenForeground2 },
  contractor: { bg: tokens.colorPaletteMarigoldBackground2, fg: tokens.colorPaletteMarigoldForeground2 },
  admin: { bg: tokens.colorPaletteRedBackground2, fg: tokens.colorPaletteRedForeground2 },
};

export function roleColor(role?: string | null): { bg: string; fg: string } {
  return (
    (role && ROLE[role]) || {
      bg: tokens.colorNeutralBackground3,
      fg: tokens.colorNeutralForeground2,
    }
  );
}

export function categoryColor(category?: string | null): { bg: string; fg: string } {
  return (
    (category && CATEGORY[category]) || {
      bg: tokens.colorNeutralBackground3,
      fg: tokens.colorNeutralForeground2,
    }
  );
}

export const humanize = (s?: string | null) => (s ?? "").replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

// A ticket in a terminal state (done). Used for bucketing and badge colour.
export const isTerminal = (status?: string | null) => status === "resolved" || status === "closed";

// Short label for a ticket's latest event — drives the card footer.
export function lastEventLabel(e?: Event): string {
  if (!e) return "No activity";
  switch (e.type) {
    case "comment": return "New comment";
    case "status": return e.to_value ? humanize(e.to_value) : "Status changed";
    case "classify": return "Classified";
    case "clock": return e.to_value ? humanize(e.to_value) : "SLA clock";
    case "attest": return "Attested";
    case "chase": return "Chased";
    default: return humanize(e.type ?? "Updated");
  }
}
