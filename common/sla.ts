// SLA event vocabulary (D21) — shared by the server (validation, evaluation) and
// the web SLA editor. Dependency-free, like tickets.ts.
import { STATUSES } from "./tickets";

// actor_role values each `event_by` group matches.
export const ROLE_GROUPS = {
  staff: ["agent", "admin"],
  contractor: ["contractor"],
  resident: ["resident"],
} as const;

// `marker` events: signals no other action records (D21).
export const MARKERS = ["enquiry_sent", "attended"] as const;

// Values each start/stop kind accepts; `ticket_created` takes none and can only start.
export const KIND_VALUES = {
  ticket_created: [],
  status: STATUSES,
  event_by: Object.keys(ROLE_GROUPS) as (keyof typeof ROLE_GROUPS)[],
  marker: MARKERS,
} as const;

export type SlaKind = keyof typeof KIND_VALUES;
export const START_KINDS = Object.keys(KIND_VALUES) as SlaKind[];
export const STOP_KINDS = START_KINDS.filter((k) => k !== "ticket_created");

// Scoring settings in the `config` table, with the format each value must match.
export const SETTINGS = {
  service_year_start: /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, // MM-DD
} as const;
export type SettingKey = keyof typeof SETTINGS;
