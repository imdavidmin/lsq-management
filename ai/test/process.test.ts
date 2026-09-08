import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import worker from "../src/index";
import { processInbound } from "../src/process";
import type { InboundEmail } from "../../common/queue";

// Fake R2 seeded with the raw message; AI omitted → summary skipped.
function makeEnv(raw: Record<string, string>) {
  const store = new Map(Object.entries(raw));
  const deleted: string[] = [];
  const env2 = {
    DB: env.DB,
    AI: undefined,
    RAW: {
      get: async (k: string) => (store.has(k) ? { text: async () => store.get(k)! } : null),
      delete: async (k: string) => void (deleted.push(k), store.delete(k)),
    },
  } as any;
  return { deleted, env: env2 };
}

const eventsFor = (ticketId: number) =>
  env.DB.prepare("SELECT * FROM events WHERE subject_type='ticket' AND subject_id=? ORDER BY id")
    .bind(ticketId)
    .all()
    .then((r) => r.results as any[]);

const rawMime = (body: string) => `Subject: x\r\nFrom: y\r\n\r\n${body}`;

beforeEach(async () => {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tickets (id, title, status, classified_by, created_at) VALUES (1234, 'Leak', 'open', 'agent', ?)"
  ).bind(new Date().toISOString()).run();
});

describe("ai Worker — processInbound", () => {
  it("records a comment from the R2 body, attributes a known account, and cleans up R2", async () => {
    const acct = await env.DB.prepare(
      "INSERT INTO accounts (email, name, active) VALUES ('res@lsq.test', 'Res', 1) RETURNING id"
    ).first<{ id: number }>();
    await env.DB.prepare(
      "INSERT INTO grants (account_id, role_key, scope_type, scope_id) VALUES (?, 'resident', 'unit', 101)"
    ).bind(acct!.id).run();

    const key = "inbound/1234/abc";
    const h = makeEnv({ [key]: rawMime("Still leaking.") });
    const msg: InboundEmail = { ticketId: 1234, from: "res@lsq.test", subject: "update", rawKey: key };
    await processInbound(h.env, msg);

    const [ev] = await eventsFor(1234);
    expect(ev.actor_id).toBe(acct!.id);
    expect(ev.actor_role).toBe("resident");
    expect(ev.body).toBe("Still leaking.");
    expect(ev.source).toBe("email");
    expect(h.deleted).toContain(key); // raw dropped after processing
  });

  it("logs an unknown sender and honours the 'no ai' opt-out", async () => {
    const key = "inbound/1234/def";
    const h = makeEnv({ [key]: rawMime("Fixed it.") });
    const msg: InboundEmail = { ticketId: 1234, from: "Stranger@nowhere.io", subject: "done NO AI", rawKey: key };
    await processInbound(h.env, msg);

    const [ev] = await eventsFor(1234);
    expect(ev.actor_email).toBe("stranger@nowhere.io");
    expect(ev.actor_role).toBeNull();
    expect(ev.ai_processed).toBe(0); // opt-out
    expect(ev.ai_summary).toBeNull();

    const s = await env.DB.prepare(
      "SELECT status, hit_count FROM senders WHERE match_value = 'stranger@nowhere.io'"
    ).first<any>();
    expect(s.status).toBe("new");
    expect(s.hit_count).toBe(1);
  });

  it("queue handler acks on success", async () => {
    const key = "inbound/1234/ghi";
    const h = makeEnv({ [key]: rawMime("hi") });
    let acked = false;
    const batch = {
      messages: [
        {
          body: { ticketId: 1234, from: "a@b.com", subject: "s", rawKey: key } as InboundEmail,
          ack: () => (acked = true),
          retry: () => {},
        },
      ],
    } as any;
    await worker.queue!(batch, h.env);
    expect(acked).toBe(true);
  });
});
