// SLA event vocabulary (D21) — shared by the server (validation, evaluation) and
// the web SLA editor. Dependency-free, like tickets.ts.
import { STATUSES } from "./tickets";

// actor_role values each `event_by` group matches. Board members are residents
// too (D37), but events carry their top role, so `board` counts as resident.
// A null role matches no group; email roles are resolved at read time (D43).
export const ROLE_GROUPS = {
  staff: ["agent", "admin", "site_staff"],
  contractor: ["contractor"],
  resident: ["resident", "board"],
} as const;

// `marker` events: signals no other action records (D21).
export const MARKERS = ["enquiry_sent", "attended", "triaged"] as const;

const FLAGS = ["needs_contractor"] as const;

// Values each start/stop kind accepts. `ticket_created` and `scheduled` only
// start; `next_step` only stops (D41); ticket_created, scheduled and next_step take no value.
export const KIND_VALUES = {
  ticket_created: [],
  status: STATUSES,
  event_by: Object.keys(ROLE_GROUPS) as (keyof typeof ROLE_GROUPS)[],
  marker: MARKERS,
  scheduled: [],
  flag: FLAGS,
  next_step: [],
} as const;

export type SlaKind = keyof typeof KIND_VALUES;
const KINDS = Object.keys(KIND_VALUES) as SlaKind[];
export const START_KINDS = KINDS.filter((k) => k !== "next_step");
export const STOP_KINDS = KINDS.filter((k) => k !== "ticket_created" && k !== "scheduled");

// Scoring settings in the `config` table, with the format each value must match.
export const SETTINGS = {
  service_year_start: /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, // MM-DD
} as const;
export type SettingKey = keyof typeof SETTINGS;
