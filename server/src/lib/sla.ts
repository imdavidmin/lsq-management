// SLA evaluation (D21): pure, over a ticket's events, computed on every read.
import { ROLE_GROUPS, type SlaKind } from "../../../common/sla";
import { workingDaysBetween } from "./workdays";

// Ball not with the agent: working days here don't count (D39).
const PAUSED = ["awaiting_resident", "awaiting_board"];
const TERMINAL = ["resolved", "closed"];

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
    case "flag":
      return e.type === "flag" && e.to_value === `${value}:1`;
    case "next_step":
      return e.type === "status" || e.type === "schedule";
    default:
      return false;
  }
}

export const applies = (sla: SlaDef, t: SlaTicket) =>
  (sla.category == null || sla.category === t.category) &&
  (sla.needs_contractor == null || sla.needs_contractor === t.needs_contractor);

// [from, to) spans (ms) the ticket sat in a paused status; an open span ends at `now`.
function pausedSpans(events: SlaEvent[], now: string): [number, number][] {
  const spans: [number, number][] = [];
  let from: number | null = null;
  for (const e of events) {
    if (e.type !== "status") continue;
    if (PAUSED.includes(e.to_value ?? "")) from ??= Date.parse(e.at);
    else if (from !== null) spans.push([from, Date.parse(e.at)]), (from = null);
  }
  if (from !== null) spans.push([from, Date.parse(now)]);
  return spans;
}

// Working days from a to b (ms) minus those spent in paused spans.
function activeDays(a: number, b: number, spans: [number, number][]): number {
  let days = workingDaysBetween(new Date(a), new Date(b));
  for (const [p0, p1] of spans) {
    const lo = Math.max(a, p0);
    const hi = Math.min(b, p1);
    if (lo < hi) days -= workingDaysBetween(new Date(lo), new Date(hi));
  }
  return days;
}

// A `schedule` event starts its instance on the scheduled date (D41). A later
// schedule replaces it; resolving or closing before the date cancels it.
function scheduledStarts(events: SlaEvent[], now: string): { idx: number; at: string }[] {
  const nowMs = Date.parse(now);
  return events.flatMap((e, i) => {
    if (e.type !== "schedule") return [];
    const date = Date.parse(e.to_value ?? "");
    if (Number.isNaN(date)) return []; // malformed date: events are append-only, so skip
    const cancelled = events.some(
      (o, j) => j > i && Date.parse(o.at) < date && (o.type === "schedule" || (o.type === "status" && TERMINAL.includes(o.to_value ?? "")))
    );
    const at = Math.max(date, Date.parse(e.at));
    if (cancelled || at > nowMs) return [];
    // Stops only count after the last event at or before the start.
    let idx = i;
    events.forEach((o, j) => { if (Date.parse(o.at) <= at) idx = Math.max(idx, j); });
    return [{ idx, at: new Date(at).toISOString() }];
  });
}

// One instance per start match (first only unless `repeats`); the stop is the
// first match strictly after the start. Open instances are judged as of `now`.
// Days exclude time paused awaiting the resident or board (D39).
export function instances(sla: SlaDef, t: SlaTicket, now: string): Instance[] {
  const starts: { idx: number; at: string }[] =
    sla.start_on === "ticket_created"
      ? [{ idx: -1, at: t.created_at }]
      : sla.start_on === "scheduled"
        ? scheduledStarts(t.events, now)
        : t.events.flatMap((e, idx) => (matches(sla.start_on, sla.start_value, e) ? [{ idx, at: e.at }] : []));
  const spans = pausedSpans(t.events, now);

  return (sla.repeats ? starts : starts.slice(0, 1)).map(({ idx, at }) => {
    const stop = t.events.find((e, i) => i > idx && matches(sla.stop_on, sla.stop_value, e));
    const days = activeDays(Date.parse(at), Date.parse(stop?.at ?? now), spans);
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
