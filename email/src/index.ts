import type { InboundEmail } from "../../common/queue";

export interface Env {
  DB: D1Database; // read-only: ticket ids + the mail_aliases config row
  INBOUND: Queue<InboundEmail>;
  RAW: R2Bucket;
  TICKET_EMAIL_DOMAIN: string;
  MAIL_DOMAIN: string;
}

// <name>@MAIL_DOMAIN → a copy to each of the alias's destinations (D26). CF
// Email Routing rules allow one destination, so copies are fanned out here.
async function forwardAlias(message: ForwardableEmailMessage, env: Env, localPart: string): Promise<void> {
  const row = await env.DB.prepare("SELECT value FROM config WHERE key = 'mail_aliases'").first<{ value: string }>();
  const aliases: Record<string, string[]> = row ? JSON.parse(row.value) : {};
  const forwardTo = aliases[localPart.toLowerCase()];
  if (!forwardTo?.length) return message.setReject("no such address");
  const results = await Promise.allSettled(forwardTo.map((to) => message.forward(to)));
  // An unverified destination fails alone; bounce only if nobody got a copy.
  for (const r of results) if (r.status === "rejected") console.error(`[alias] ${localPart}: ${r.reason}`);
  if (!results.some((r) => r.status === "fulfilled")) message.setReject("delivery failed");
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
