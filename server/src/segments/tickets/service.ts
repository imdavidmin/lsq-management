import type { Env } from "../../env";
import { all, one, run } from "../../db/client";
import type { Grant } from "../../db/client";
import type { TicketStatus } from "../../../../common/tickets";

export interface Ticket {
  id: number;
  title: string;
  building_id: number | null;
  unit_id: number | null;
  created_by: number | null;
  category: string | null;
  classified_by: string; // role that last set the category (resident|agent|board|admin)
  needs_contractor: number;
  is_duplicate: number;
  status: TicketStatus;
  created_at: string;
  resolved_at: string | null;
  closed_at: string | null;
}

export interface TicketEvent {
  id: number;
  subject_type: string;
  subject_id: number | null;
  at: string;
  actor_id: number | null;
  actor_email: string | null;
  actor_role: string | null;
  type: string;
  from_value: string | null;
  to_value: string | null;
  body: string | null;
  source: string;
  ai_processed: number;
  ai_summary: string | null;
}

// Re-exported from common (shared with the ai Worker's sender attribution).
export { primaryRole } from "../../../../common/roles";

// SQL fragment restricting `tickets t` to what these (ticket:read) grants see.
// estate → everything; otherwise OR of building/unit/ticket scopes. Empty → none.
function visibility(grants: Grant[]): { sql: string; params: unknown[] } {
  if (grants.some((g) => g.scope_type === "estate")) return { sql: "1=1", params: [] };
  const clauses: string[] = [];
  const params: unknown[] = [];
  const ids = (t: Grant["scope_type"]) =>
    grants.filter((g) => g.scope_type === t && g.scope_id != null).map((g) => g.scope_id!);

  const buildings = ids("building");
  if (buildings.length) {
    const ph = buildings.map(() => "?").join(",");
    clauses.push(
      `(t.building_id IN (${ph}) OR t.unit_id IN (SELECT id FROM units WHERE building_id IN (${ph})))`
    );
    params.push(...buildings, ...buildings);
  }
  const units = ids("unit");
  if (units.length) {
    clauses.push(`t.unit_id IN (${units.map(() => "?").join(",")})`);
    params.push(...units);
  }
  const tickets = ids("ticket");
  if (tickets.length) {
    clauses.push(`t.id IN (${tickets.map(() => "?").join(",")})`);
    params.push(...tickets);
  }
  return clauses.length ? { sql: `(${clauses.join(" OR ")})`, params } : { sql: "1=0", params: [] };
}

export interface ListFilters {
  status?: string;
  category?: string;
  building_id?: number;
  unit_id?: number;
  mine?: boolean;
  page: number;
  per_page: number;
}

export async function listTickets(
  env: Env,
  grants: Grant[],
  accountId: number,
  f: ListFilters
): Promise<{ data: (Ticket & { events: TicketEvent[] })[]; page: number; total: number }> {
  const vis = visibility(grants);
  const where = [vis.sql];
  const params = [...vis.params];
  if (f.status) (where.push("t.status = ?"), params.push(f.status));
  if (f.category) (where.push("t.category = ?"), params.push(f.category));
  if (f.building_id != null) (where.push("t.building_id = ?"), params.push(f.building_id));
  if (f.unit_id != null) (where.push("t.unit_id = ?"), params.push(f.unit_id));
  if (f.mine) (where.push("t.created_by = ?"), params.push(accountId));
  const clause = where.join(" AND ");

  const total = await one<{ n: number }>(
    env.DB,
    `SELECT COUNT(*) n FROM tickets t WHERE ${clause}`,
    ...params
  );
  const offset = (f.page - 1) * f.per_page;
  const data = await all<Ticket>(
    env.DB,
    `SELECT t.* FROM tickets t WHERE ${clause} ORDER BY t.id DESC LIMIT ? OFFSET ?`,
    ...params,
    f.per_page,
    offset
  );

  // Attach each ticket's timeline (one query for the page); FE derives activity.
  const ids = data.map((t) => t.id);
  const events = ids.length
    ? await all<TicketEvent>(
        env.DB,
        `SELECT * FROM events WHERE subject_type = 'ticket' AND subject_id IN (${ids.map(() => "?").join(",")}) ORDER BY at, id`,
        ...ids
      )
    : [];
  const byTicket = new Map<number, TicketEvent[]>();
  for (const e of events) {
    const arr = byTicket.get(e.subject_id!) ?? [];
    arr.push(e);
    byTicket.set(e.subject_id!, arr);
  }
  return {
    data: data.map((t) => ({ ...t, events: byTicket.get(t.id) ?? [] })),
    page: f.page,
    total: total?.n ?? 0,
  };
}

export async function getTicket(env: Env, id: number): Promise<Ticket | null> {
  return one<Ticket>(env.DB, "SELECT * FROM tickets WHERE id = ?", id);
}

export interface Attachment {
  id: number;
  event_id: number;
  kind: "file" | "original";
  filename: string;
  content_type: string;
  size: number;
}

// A ticket's timeline, each event with its attachments and actor_name. The name
// resolves at read time, also via extra account addresses (D29); actor_role is
// never re-derived, so SLA results don't move (D7, D21).
export async function ticketEvents(
  env: Env,
  id: number
): Promise<(TicketEvent & { actor_name: string | null; attachments: Omit<Attachment, "event_id">[] })[]> {
  const [events, attachments] = await Promise.all([
    all<TicketEvent & { actor_name: string | null }>(
      env.DB,
      `SELECT e.*, COALESCE(a.name, pa.name, la.name) AS actor_name
         FROM events e
         LEFT JOIN accounts a ON a.id = e.actor_id
         LEFT JOIN accounts pa ON pa.email = e.actor_email
         LEFT JOIN account_emails ae ON ae.email = e.actor_email
         LEFT JOIN accounts la ON la.id = ae.account_id
        WHERE e.subject_type = 'ticket' AND e.subject_id = ?
        ORDER BY e.at, e.id`,
      id
    ),
    all<Attachment>(
      env.DB,
      `SELECT a.id, a.event_id, a.kind, a.filename, a.content_type, a.size
         FROM attachments a JOIN events e ON e.id = a.event_id
        WHERE e.subject_type = 'ticket' AND e.subject_id = ? ORDER BY a.id`,
      id
    ),
  ]);
  return events.map((e) => ({
    ...e,
    attachments: attachments.filter((a) => a.event_id === e.id).map(({ event_id, ...a }) => a),
  }));
}

// An attachment on one of this ticket's events (null if it belongs elsewhere).
export const ticketAttachment = (env: Env, ticketId: number, attachmentId: number) =>
  one<Attachment & { r2_key: string }>(
    env.DB,
    `SELECT a.* FROM attachments a JOIN events e ON e.id = a.event_id
      WHERE a.id = ? AND e.subject_type = 'ticket' AND e.subject_id = ?`,
    attachmentId,
    ticketId
  );

interface EventInput {
  actor_id?: number | null;
  actor_role?: string | null;
  type: string;
  from_value?: string | null;
  to_value?: string | null;
  body?: string | null;
  source: string;
  ai_processed?: number;
  ai_summary?: string | null;
}

async function appendEvent(env: Env, ticketId: number, at: string, e: EventInput): Promise<number> {
  const res = await run(
    env.DB,
    `INSERT INTO events
       (subject_type, subject_id, at, actor_id, actor_email, actor_role,
        type, from_value, to_value, body, source, ai_processed, ai_summary)
     VALUES ('ticket', ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ticketId,
    at,
    e.actor_id ?? null,
    e.actor_role ?? null,
    e.type,
    e.from_value ?? null,
    e.to_value ?? null,
    e.body ?? null,
    e.source,
    e.ai_processed ?? 0,
    e.ai_summary ?? null
  );
  return res.meta.last_row_id as number;
}

export async function getEvent(env: Env, eventId: number): Promise<TicketEvent | null> {
  return one<TicketEvent>(env.DB, "SELECT * FROM events WHERE id = ?", eventId);
}

export interface CreateInput {
  title: string;
  description: string;
  category?: string;
  building_id?: number | null;
  unit_id?: number | null;
}

// Create a ticket + its first comment and a classify event recording the
// creator's chosen category. The category picker is optional: leave it blank and
// the ticket is unclassified until an agent categorises it (UJ-05). No AI on the
// web-create path — email summarisation is the only Workers AI use (ai Worker).
export async function createTicket(
  env: Env,
  accountId: number,
  role: string,
  input: CreateInput
): Promise<Ticket> {
  const now = new Date().toISOString();
  const category = input.category ?? null;
  const res = await run(
    env.DB,
    `INSERT INTO tickets (title, building_id, unit_id, created_by, category, classified_by, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
    input.title,
    input.building_id ?? null,
    input.unit_id ?? null,
    accountId,
    category,
    role,
    now
  );
  const id = res.meta.last_row_id as number;

  await appendEvent(env, id, now, {
    actor_id: accountId,
    actor_role: role,
    type: "comment",
    body: input.description,
    source: "ui",
  });
  await appendEvent(env, id, now, {
    actor_id: accountId,
    actor_role: role,
    type: "classify",
    to_value: category,
    body: category ? null : "Unclassified — an agent will categorise",
    source: "ui",
  });

  return (await getTicket(env, id))!;
}

export interface PatchInput {
  status?: string;
  category?: string;
  needs_contractor?: boolean;
  is_duplicate?: boolean;
}

// Apply field changes and append one audit event per changed field.
export async function patchTicket(
  env: Env,
  ticket: Ticket,
  accountId: number,
  role: string,
  p: PatchInput
): Promise<Ticket> {
  const now = new Date().toISOString();
  const actor = { actor_id: accountId, actor_role: role, source: "ui" as const };

  if (p.category !== undefined && p.category !== ticket.category) {
    // Agent reassigns live; board reclassification is classified_by=board (UJ-06/08).
    const by = role === "board" ? "board" : "agent";
    await run(env.DB, "UPDATE tickets SET category = ?, classified_by = ? WHERE id = ?", p.category, by, ticket.id);
    await appendEvent(env, ticket.id, now, {
      ...actor,
      type: "classify",
      from_value: ticket.category,
      to_value: p.category,
    });
  }

  if (p.status !== undefined && p.status !== ticket.status) {
    const stamp =
      p.status === "resolved" ? ", resolved_at = ?" : p.status === "closed" ? ", closed_at = ?" : "";
    const args: unknown[] = [p.status];
    if (stamp) args.push(now);
    args.push(ticket.id);
    await run(env.DB, `UPDATE tickets SET status = ?${stamp} WHERE id = ?`, ...args);
    await appendEvent(env, ticket.id, now, {
      ...actor,
      type: "status",
      from_value: ticket.status,
      to_value: p.status,
    });
  }

  for (const flag of ["needs_contractor", "is_duplicate"] as const) {
    const next = p[flag];
    if (next === undefined) continue;
    const val = next ? 1 : 0;
    if (val === ticket[flag]) continue;
    await run(env.DB, `UPDATE tickets SET ${flag} = ? WHERE id = ?`, val, ticket.id);
    await appendEvent(env, ticket.id, now, {
      ...actor,
      type: "status",
      from_value: `${flag}:${ticket[flag]}`,
      to_value: `${flag}:${val}`,
    });
  }

  return (await getTicket(env, ticket.id))!;
}

export async function addComment(
  env: Env,
  ticketId: number,
  accountId: number,
  role: string,
  body: string,
  marker?: string
): Promise<TicketEvent> {
  const now = new Date().toISOString();
  const id = await appendEvent(env, ticketId, now, {
    actor_id: accountId,
    actor_role: role,
    type: marker ? "marker" : "comment",
    to_value: marker ?? null,
    body,
    source: "ui",
  });
  return (await getEvent(env, id))!;
}
