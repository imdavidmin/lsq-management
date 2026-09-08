import type { InboundEmail } from "../../common/queue";

export interface Env {
  DB: D1Database; // read-only: reject mail for unknown ticket ids at the door
  INBOUND: Queue<InboundEmail>;
  RAW: R2Bucket;
}

// Deliberately tiny: email() handlers run under a tight budget, so this only
// validates the ticket address, stashes the raw message in R2, and enqueues its
// key. All resolution/AI/DB-writes happen off the critical path in the ai Worker.
export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const at = message.to.indexOf("@");
    const localPart = (at >= 0 ? message.to.slice(0, at) : message.to).trim();
    const ticketId = Number(localPart);
    if (!Number.isInteger(ticketId) || ticketId <= 0)
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
