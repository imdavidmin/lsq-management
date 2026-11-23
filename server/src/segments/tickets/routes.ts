import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../env";
import { body, idParam } from "../../lib/validate";
import { badRequest, notFound } from "../../lib/errors";
import { requireSession } from "../../middleware/session";
import { requirePermission, readableGrants } from "../../middleware/rbac";
import type { ScopeRef } from "../../lib/scope";
import { emailRoles } from "../../lib/emailRoles";
import { STATUSES } from "../../../../common/tickets";
import {
  addComment,
  addSchedule,
  createTicket,
  emailCreator,
  getTicket,
  handBack,
  listTickets,
  patchTicket,
  primaryRole,
  ticketAttachment,
  ticketEvents,
  triageTicket,
  withSlaDue,
  type Ticket,
  type TicketEvent,
} from "./service";

// Scope of an existing ticket, resolved from the path id.
const ticketScope = (c: any): ScopeRef => ({ type: "ticket", id: idParam(c) });

// Numeric-flag columns → booleans to match openapi component schemas; reply_to
// is the ticket's inbound address (D25).
const serializeTicket = (t: Ticket, domain: string) => ({
  ...t,
  reply_to: `${t.id}@${domain}`,
  needs_contractor: !!t.needs_contractor,
});
const serializeEvent = (e: TicketEvent) => ({ ...e, ai_processed: !!e.ai_processed });

// sla_due only for callers who may read SLAs (D36); everyone else gets null.
async function slaDue<T extends Ticket & { events: TicketEvent[] }>(c: any, rows: T[]) {
  if (!(await readableGrants(c, "sla:read")).length) return rows.map((t) => ({ ...t, sla_due: null }));
  return withSlaDue(c.env, rows, new Date());
}

// Hides contractor (and still-unknown) email senders from callers without
// ticket:read_contractor (D44). Applied after SLA evaluation, which needs them all.
async function eventVisible(c: any) {
  if ((await readableGrants(c, "ticket:read_contractor")).length) return () => true;
  const resolve = await emailRoles(c.env.DB);
  return (e: Pick<TicketEvent, "actor_id" | "actor_email" | "actor_role">) => {
    const role = resolve(e).actor_role;
    return role !== "contractor" && !(role == null && e.actor_email);
  };
}

const createSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  category: z.string().min(1).optional(),
  building_id: z.number().int().nullish(),
  unit_id: z.number().int().nullish(),
});
// A real calendar date, today or later (UTC).
const isoDate = z
  .string()
  .date()
  .refine((d) => d >= new Date().toISOString().slice(0, 10), "date is in the past");
const patchSchema = z
  .object({
    status: z.enum(STATUSES),
    category: z.string().min(1),
    needs_contractor: z.boolean(),
    duplicate_of: z.number().int().positive(),
  })
  .partial();
const triageSchema = z
  .object({
    category: z.string().min(1),
    needs_contractor: z.boolean(),
    status: z.enum(STATUSES).exclude(["open"]).optional(),
    date: isoDate.optional(),
    note: z.string().trim().min(1).optional(),
  })
  .refine((v) => (v.status === undefined) !== (v.date === undefined), "give exactly one of status or date")
  .refine((v) => (v.date === undefined) === (v.note === undefined), "note goes with date, and date needs a note");
const scheduleSchema = z.object({ date: isoDate, note: z.string().trim().min(1) });
const done = (s: string) => s === "resolved" || s === "closed";
const commentSchema = z.object({ body: z.string().min(1) });
// Only `attended` is entered by hand; the other markers are system-inferred (D21).
const markerSchema = z.object({ marker: z.enum(["attended"]), notes: z.string().trim().min(1) });
const listSchema = z.object({
  status: z.enum(STATUSES).optional(),
  category: z.string().optional(),
  building_id: z.coerce.number().int().optional(),
  unit_id: z.coerce.number().int().optional(),
  // z.coerce.boolean() treats "false" as true; match only true/1.
  mine: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true" || v === "1")),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(25),
});

export const tickets = new Hono<AppContext>();
tickets.use("*", requireSession);

// GET /tickets — visible to caller via ticket:read grants, filtered + paged.
tickets.get("/", requirePermission("ticket:read"), async (c) => {
  const parsed = listSchema.safeParse(c.req.query());
  if (!parsed.success) return badRequest(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const grants = await readableGrants(c, "ticket:read");
  const account = c.get("account");
  const res = await listTickets(c.env, grants, account.id, parsed.data);
  const visible = await eventVisible(c);
  const data = (await slaDue(c, res.data)).map((t) => ({
    ...serializeTicket(t, c.env.TICKET_EMAIL_DOMAIN),
    events: t.events.filter(visible).map(serializeEvent),
  }));
  return c.json({ data, page: res.page, total: res.total });
});

// POST /tickets — scope is the target unit/building (else estate for communal).
// The scope resolver and handler both read c.req.json(); Hono caches it.
tickets.post(
  "/",
  requirePermission("ticket:create", async (c): Promise<ScopeRef> => {
    const b = (await c.req.json().catch(() => ({}))) as {
      unit_id?: number | null;
      building_id?: number | null;
    };
    if (b?.unit_id != null) return { type: "unit", id: b.unit_id };
    if (b?.building_id != null) return { type: "building", id: b.building_id };
    return { type: "estate", id: null };
  }),
  async (c) => {
    const input = await body(c, createSchema);
    const account = c.get("account");
    const t = await createTicket(c.env, account.id, primaryRole(c.get("grants")), input);
    return c.json(serializeTicket(t, c.env.TICKET_EMAIL_DOMAIN), 201);
  }
);

tickets.get("/:id", requirePermission("ticket:read", ticketScope), async (c) => {
  const t = await getTicket(c.env, idParam(c));
  if (!t) notFound("no such ticket");
  const row = (await slaDue(c, [{ ...t!, events: await ticketEvents(c.env, t!.id) }]))[0]!;
  const visible = await eventVisible(c);
  return c.json({ ...serializeTicket(row, c.env.TICKET_EMAIL_DOMAIN), events: row.events.filter(visible).map(serializeEvent) });
});

tickets.get("/:id/events", requirePermission("ticket:read", ticketScope), async (c) => {
  const events = await ticketEvents(c.env, idParam(c));
  return c.json(events.filter(await eventVisible(c)).map(serializeEvent));
});

// Files come from strangers' email and are served from our origin: never sniffed,
// sandboxed, and downloaded unless they're a plain image or PDF (D28).
const INLINE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"];

tickets.get("/:id/attachments/:attachmentId", requirePermission("ticket:read", ticketScope), async (c) => {
  const found = await ticketAttachment(c.env, idParam(c), Number(c.req.param("attachmentId")));
  const att = found && (await eventVisible(c))(found) ? found : null;
  const obj = att && (await c.env.MAIL.get(att.r2_key));
  if (!att || !obj) notFound("no such attachment");
  const inline = INLINE_TYPES.includes(att!.content_type);
  return new Response(obj!.body, {
    headers: {
      "Content-Type": inline ? att!.content_type : "application/octet-stream",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(att!.filename)}`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
    },
  });
});

tickets.patch("/:id", requirePermission("ticket:update", ticketScope), async (c) => {
  const p = await body(c, patchSchema);
  const t = await getTicket(c.env, idParam(c));
  if (!t) notFound("no such ticket");
  if (done(t!.status) && p.status && !done(p.status)) badRequest("a resolved or closed ticket can't be reopened");
  if (p.duplicate_of !== undefined) {
    // D42: only an older ticket can be the original.
    const orig = await getTicket(c.env, p.duplicate_of);
    if (!orig || orig.id === t!.id || orig.created_at >= t!.created_at) badRequest("duplicate_of must be an older ticket");
  }
  const input = p.duplicate_of !== undefined ? { ...p, status: "closed" as const } : p;
  const account = c.get("account");
  const updated = await patchTicket(c.env, t!, account.id, primaryRole(c.get("grants")), input);
  return c.json(serializeTicket(updated, c.env.TICKET_EMAIL_DOMAIN));
});

tickets.post("/:id/events", requirePermission("ticket:comment", ticketScope), async (c) => {
  const { body: text } = await body(c, commentSchema);
  const t = await getTicket(c.env, idParam(c));
  if (!t) notFound("no such ticket");
  const account = c.get("account");
  const ev = await addComment(c.env, t!.id, account.id, primaryRole(c.get("grants")), text);
  await handBack(c.env, t!, primaryRole(c.get("grants")));
  await emailCreator(c.env, t!, account.id, text);
  return c.json(serializeEvent(ev), 201);
});

tickets.post("/:id/markers", requirePermission("ticket:update", ticketScope), async (c) => {
  const { marker, notes } = await body(c, markerSchema);
  const t = await getTicket(c.env, idParam(c));
  if (!t) notFound("no such ticket");
  if (done(t!.status)) badRequest("ticket is already resolved or closed");
  const account = c.get("account");
  const ev = await addComment(c.env, t!.id, account.id, primaryRole(c.get("grants")), notes, marker);
  return c.json(serializeEvent(ev), 201);
});

tickets.post("/:id/triage", requirePermission("ticket:update", ticketScope), async (c) => {
  const i = await body(c, triageSchema);
  const t = await getTicket(c.env, idParam(c));
  if (!t) notFound("no such ticket");
  if (done(t!.status)) badRequest("ticket is already resolved or closed");
  if (i.status === t!.status) badRequest("choose a different status or a date");
  const account = c.get("account");
  const updated = await triageTicket(c.env, t!, account.id, primaryRole(c.get("grants")), i);
  return c.json(serializeTicket(updated, c.env.TICKET_EMAIL_DOMAIN));
});

tickets.post("/:id/schedule", requirePermission("ticket:update", ticketScope), async (c) => {
  const { date, note } = await body(c, scheduleSchema);
  const t = await getTicket(c.env, idParam(c));
  if (!t) notFound("no such ticket");
  if (done(t!.status)) badRequest("ticket is already resolved or closed");
  const account = c.get("account");
  const ev = await addSchedule(c.env, t!.id, account.id, primaryRole(c.get("grants")), date, note);
  return c.json(serializeEvent(ev), 201);
});
