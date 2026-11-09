// SLA evaluation (D21): pure, over a ticket's events, computed on every read.
import { ROLE_GROUPS, type SlaKind } from "../../../common/sla";
import { workingDaysBetween } from "./workdays";

export interface SlaDef {
  id: number;
  category: string | null;
  needs_contractor: number | null;
  start_on: string;
  start_value: string | null;
  stop_on: string;
  stop_value: string | null;
  budget_days: number;
  repeats: number;
}

export interface SlaEvent {
  at: string;
  actor_role: string | null;
  type: string;
  to_value: string | null;
}

export interface SlaTicket {
  category: string | null;
  needs_contractor: number;
  created_at: string;
  events: SlaEvent[]; // ordered by (at, id)
}

export type Outcome = "met" | "breached" | "running";

export interface Instance {
  sla_id: number;
  start_at: string;
  stop_at: string | null;
  days: number;
  outcome: Outcome;
}

function matches(kind: string, value: string | null, e: SlaEvent): boolean {
  switch (kind as SlaKind) {
    case "status":
      return e.type === "status" && e.to_value === value;
    case "event_by":
      return (ROLE_GROUPS[value as keyof typeof ROLE_GROUPS] as readonly string[] | undefined)?.includes(e.actor_role ?? "") ?? false;
    case "marker":
      return e.type === "marker" && e.to_value === value;
    default:
      return false;
  }
}

export const applies = (sla: SlaDef, t: SlaTicket) =>
  (sla.category == null || sla.category === t.category) &&
  (sla.needs_contractor == null || sla.needs_contractor === t.needs_contractor);

// One instance per start match (first only unless `repeats`); the stop is the
// first match strictly after the start. Open instances are judged as of `now`.
export function instances(sla: SlaDef, t: SlaTicket, now: string): Instance[] {
  const starts: { idx: number; at: string }[] =
    sla.start_on === "ticket_created"
      ? [{ idx: -1, at: t.created_at }]
      : t.events.flatMap((e, idx) => (matches(sla.start_on, sla.start_value, e) ? [{ idx, at: e.at }] : []));

  return (sla.repeats ? starts : starts.slice(0, 1)).map(({ idx, at }) => {
    const stop = t.events.find((e, i) => i > idx && matches(sla.stop_on, sla.stop_value, e));
    const days = workingDaysBetween(at, stop?.at ?? now);
    const outcome: Outcome = days > sla.budget_days ? "breached" : stop ? "met" : "running";
    return { sla_id: sla.id, start_at: at, stop_at: stop?.at ?? null, days, outcome };
  });
}

// A ticket passes a metric when all its finished instances are met; with none
// finished it doesn't count (null).
export function ticketPasses(slas: SlaDef[], t: SlaTicket, now: string): boolean | null {
  const done = slas
    .filter((s) => applies(s, t))
    .flatMap((s) => instances(s, t, now))
    .filter((i) => i.outcome !== "running");
  return done.length ? done.every((i) => i.outcome === "met") : null;
}

// The open instance nearest its budget, for the tickets list: working days left
// (negative = overdue). Null when nothing is running.
export function nextDue(
  slas: (SlaDef & { name: string })[],
  t: SlaTicket,
  now: string
): { sla_id: number; name: string; remaining_days: number } | null {
  let best: { sla_id: number; name: string; remaining_days: number } | null = null;
  for (const s of slas.filter((s) => applies(s, t))) {
    for (const i of instances(s, t, now)) {
      if (i.stop_at) continue;
      const remaining = s.budget_days - i.days;
      if (!best || remaining < best.remaining_days) best = { sla_id: s.id, name: s.name, remaining_days: remaining };
    }
  }
  return best;
}
