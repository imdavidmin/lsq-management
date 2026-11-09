import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../env";
import { body, idParam } from "../../lib/validate";
import { badRequest, notFound } from "../../lib/errors";
import { requireSession } from "../../middleware/session";
import { requirePermission, readableGrants } from "../../middleware/rbac";
import type { ScopeRef } from "../../lib/scope";
import { STATUSES } from "../../../../common/tickets";
import {
  addComment,
  createTicket,
  emailCreator,
  getTicket,
  listTickets,
  patchTicket,
  primaryRole,
  ticketAttachment,
  ticketEvents,
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
  is_duplicate: !!t.is_duplicate,
});
const serializeEvent = (e: TicketEvent) => ({ ...e, ai_processed: !!e.ai_processed });

const createSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  category: z.string().min(1).optional(),
  building_id: z.number().int().nullish(),
  unit_id: z.number().int().nullish(),
});
const patchSchema = z
  .object({
    status: z.enum(STATUSES),
    category: z.string().min(1),
    needs_contractor: z.boolean(),
    is_duplicate: z.boolean(),
  })
  .partial();
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
  const data = res.data.map((t) => ({ ...serializeTicket(t, c.env.TICKET_EMAIL_DOMAIN), events: t.events.map(serializeEvent) }));
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
  const events = await ticketEvents(c.env, t!.id);
  return c.json({ ...serializeTicket(t!, c.env.TICKET_EMAIL_DOMAIN), events: events.map(serializeEvent) });
});

tickets.get("/:id/events", requirePermission("ticket:read", ticketScope), async (c) => {
  const events = await ticketEvents(c.env, idParam(c));
  return c.json(events.map(serializeEvent));
});

// Files come from strangers' email and are served from our origin: never sniffed,
// sandboxed, and downloaded unless they're a plain image or PDF (D28).
const INLINE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"];

tickets.get("/:id/attachments/:attachmentId", requirePermission("ticket:read", ticketScope), async (c) => {
  const att = await ticketAttachment(c.env, idParam(c), Number(c.req.param("attachmentId")));
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
  const account = c.get("account");
  const updated = await patchTicket(c.env, t!, account.id, primaryRole(c.get("grants")), p);
  return c.json(serializeTicket(updated, c.env.TICKET_EMAIL_DOMAIN));
});

tickets.post("/:id/events", requirePermission("ticket:comment", ticketScope), async (c) => {
  const { body: text } = await body(c, commentSchema);
  const t = await getTicket(c.env, idParam(c));
  if (!t) notFound("no such ticket");
  const account = c.get("account");
  const ev = await addComment(c.env, t!.id, account.id, primaryRole(c.get("grants")), text);
  await emailCreator(c.env, t!, account.id, text, new URL(c.req.url).origin);
  return c.json(serializeEvent(ev), 201);
});

tickets.post("/:id/markers", requirePermission("ticket:update", ticketScope), async (c) => {
  const { marker, notes } = await body(c, markerSchema);
  const t = await getTicket(c.env, idParam(c));
  if (!t) notFound("no such ticket");
  const account = c.get("account");
  const ev = await addComment(c.env, t!.id, account.id, primaryRole(c.get("grants")), notes, marker);
  return c.json(serializeEvent(ev), 201);
});
