import { Hono } from "hono";
import type { AppContext } from "../../env";
import { badRequest, unauthorized } from "../../lib/errors";

// Delivery problems worth a human look; console.error raises a Sentry alert (D38).
const ALERT_EVENTS = new Set(["activity.hard_bounced", "activity.spam_complaint", "activity.suppressed"]);

// Signature = hex HMAC-SHA256 of the raw body; subtle.verify compares in constant time.
async function validSignature(secret: string, body: string, signature: string): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/i.test(signature)) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const sig = new Uint8Array(signature.match(/../g)!.map((h) => parseInt(h, 16)));
  return crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(body));
}

export const webhooks = new Hono<AppContext>();

// POST /webhooks/mailersend — MailerSend delivery events (D38).
webhooks.post("/mailersend", async (c) => {
  const raw = await c.req.text();
  let event: { type?: string; data?: { recipient?: string; subject?: string; meta?: { bounce_reason?: string; suppression_reason?: string } } };
  try {
    event = JSON.parse(raw) ?? {};
  } catch {
    return badRequest("invalid json");
  }
  // MailerSend's save-time ping is signed with a public test secret; it triggers nothing, so ack it unchecked.
  if (event.type === "webhook.test") return c.body(null, 204);

  const secret = c.env.MAILERSEND_WEBHOOK_SECRET;
  if (!secret || !(await validSignature(secret, raw, c.req.header("signature") ?? "")))
    unauthorized("bad signature");

  if (ALERT_EVENTS.has(event.type!)) {
    const d = event.data ?? {};
    console.error(`[mail] ${event.type} to=${d.recipient} subject=${d.subject} reason=${d.meta?.bounce_reason ?? d.meta?.suppression_reason ?? ""}`);
  }
  return c.body(null, 204);
});
