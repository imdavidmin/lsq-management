// Shared ticket constants — source of truth for both server and web. Keep this
// file dependency-free (no worker/browser types) so either bundle can import it.

// Provisional category set (UJ-05); see server classify.ts.
export const CATEGORIES = [
  "site_defect",
  "cleaning",
  "reactive_fault",
  "communal_repair",
  "resident_query",
  "complaint",
  "other",
] as const;

// Ticket lifecycle. Server validates against this (zod) and stores it; web
// renders the status dropdown from it.
export const STATUSES = ["open", "pending_3rd_party", "resolved", "closed"] as const;
export type TicketStatus = (typeof STATUSES)[number];
