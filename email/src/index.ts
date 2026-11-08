import { TRIAGE_INBOXES, type QueuedEmail, type TriageInbox } from "../../common/queue";

export interface Env {
  DB: D1Database; // read-only: ticket ids, the mail_aliases config row, sender accounts
  INBOUND: Queue<QueuedEmail>;
  RAW: R2Bucket;
  TICKET_EMAIL_DOMAIN: string;
  MAIL_DOMAIN: string;
}

// Bare address from a From header ("Name <a@b>" or "a@b"), lowercased.
const headerAddress = (from: string | null) => (from?.match(/<([^<>]+)>\s*$/)?.[1] ?? from ?? "").trim().toLowerCase();

// A triage-eligible message's sender account (D32): not opted out of AI, not an
// auto-reply, sent from a known address. Anything else is only forwarded.
async function triageAccount(message: ForwardableEmailMessage, env: Env): Promise<number | null> {
  if (/no ai/i.test(message.headers.get("subject") ?? "")) return null;
  const auto = message.headers.get("auto-submitted");
  if (auto && auto.toLowerCase() !== "no") return null;
  const from = message.from.toLowerCase();
  const account = await env.DB.prepare(
    `SELECT a.id FROM accounts a LEFT JOIN account_emails ae ON ae.account_id = a.id
      WHERE a.active = 1 AND (a.email = ? OR ae.email = ?) LIMIT 1`
  )
    .bind(from, from)
    .first<{ id: number }>();
  return account?.id ?? null;
}

// <name>@MAIL_DOMAIN → a copy to each of the alias's destinations (D26). CF
// Email Routing rules allow one destination, so copies are fanned out here.
// Triage inboxes also queue the message for a ticket (D32).
async function forwardAlias(message: ForwardableEmailMessage, env: Env, localPart: string): Promise<void> {
  const name = localPart.toLowerCase();
  const row = await env.DB.prepare("SELECT value FROM config WHERE key = 'mail_aliases'").first<{ value: string }>();
  const aliases: Record<string, string[]> = row ? JSON.parse(row.value) : {};
  const forwardTo = aliases[name];
  if (!forwardTo?.length) return message.setReject("no such address");

  const inbox = (TRIAGE_INBOXES as readonly string[]).includes(name) ? (name as TriageInbox) : null;
  const accountId = inbox ? await triageAccount(message, env) : null;
  const raw = accountId ? await new Response(message.raw).arrayBuffer() : null;

  const results = await Promise.allSettled(forwardTo.map((to) => message.forward(to)));
  // An unverified destination fails alone; bounce only if nobody got a copy.
  for (const r of results) if (r.status === "rejected") console.error(`[alias] ${name}: ${r.reason}`);
  if (!results.some((r) => r.status === "fulfilled")) return message.setReject("delivery failed");

  if (!inbox || !accountId || !raw) return;
  // The mail is already delivered, so a triage failure is logged, never bounced.
  try {
    const rawKey = `triage/${inbox}/${crypto.randomUUID()}`;
    await env.RAW.put(rawKey, raw);
    await env.INBOUND.send({
      inbox,
      accountId,
      from: message.from.toLowerCase(),
      subject: message.headers.get("subject") ?? "",
      rawKey,
    });
  } catch (err) {
    console.error(`[triage] ${name}: enqueue failed`, err);
  }
}

// Deliberately tiny: email() handlers run under a tight budget. Main-domain
// aliases are forwarded; ticket mail is validated, stashed in R2 and its key
// enqueued. All resolution/AI/DB-writes happen off the critical path in the ai Worker.
export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const at = message.to.lastIndexOf("@");
    const localPart = message.to.slice(0, at).trim();
    const domain = message.to.slice(at + 1).trim().toLowerCase();
    if (domain === env.MAIL_DOMAIN) return forwardAlias(message, env, localPart);
    const ticketId = Number(localPart);
    if (domain !== env.TICKET_EMAIL_DOMAIN || !Number.isInteger(ticketId) || ticketId <= 0)
      return message.setReject("unrecognised ticket address");
    // The triage notice comes from new@ and CCs the ticket; it isn't a comment (D32).
    if (headerAddress(message.headers.get("from")) === `new@${env.TICKET_EMAIL_DOMAIN}`) return;

    const exists = await env.DB.prepare("SELECT 1 FROM tickets WHERE id = ?").bind(ticketId).first();
    if (!exists) return message.setReject("no such ticket");

    // Raw message can exceed the 128 KB queue limit (attachments) → R2, key only
    // on the queue. Buffer to ArrayBuffer so the put has a known length.
    const rawKey = `inbound/${ticketId}/${crypto.randomUUID()}`;
    await env.RAW.put(rawKey, await new Response(message.raw).arrayBuffer());
    await env.INBOUND.send({
      ticketId,
      from: message.from.toLowerCase(),
      subject: message.headers.get("subject") ?? "",
      rawKey,
    });
  },
} satisfies ExportedHandler<Env>;
