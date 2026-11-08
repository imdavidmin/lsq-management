import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../src/index";
import { triageInbound } from "../src/triage";
import type { TriageEmail } from "../../common/queue";

// Fake R2 + AI; DB is the migrated pool D1. MailerSend calls are captured from fetch.
function makeEnv(raw: Record<string, string>, ai: unknown) {
  const store = new Map<string, string | ArrayBuffer | Uint8Array>(Object.entries(raw));
  return {
    DB: env.DB,
    AI: {
      run: async (model: string) => (model.includes("bart") ? { summary: "short summary" } : { response: ai }),
    },
    RAW: {
      get: async (k: string) =>
        store.has(k) ? { arrayBuffer: async () => new Response(store.get(k)!).arrayBuffer() } : null,
      put: async (k: string, v: ArrayBuffer | Uint8Array) => void store.set(k, v),
    },
    TICKET_EMAIL_DOMAIN: "ticket.lansburysquare.co.uk",
    MAIL_DOMAIN: "lansburysquare.co.uk",
    MAIL_FROM: "ops@lansburysquare.co.uk",
    MAIL_FROM_NAME: "Lansbury Square",
    MAILERSEND_API_KEY: "mlsn.test",
  } as any;
}

let mail: any[] = [];
beforeEach(async () => {
  mail = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    mail.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 202 });
  });
  await env.DB.batch([
    env.DB.prepare("INSERT INTO config (key, value) VALUES ('mail_aliases', ?)").bind(
      JSON.stringify({ concierge: ["desk@gmail.com", "night@gmail.com"], management: ["pm@agentco.co.uk"] })
    ),
    env.DB.prepare("INSERT INTO units (id, building_id, label) VALUES (501, 1, 'Flat 5')"),
    env.DB.prepare("INSERT INTO accounts (id, email, name, active) VALUES (70, 'res@lsq.test', 'Res', 1)"),
    env.DB.prepare("INSERT INTO grants (account_id, role_key, scope_type, scope_id) VALUES (70, 'resident', 'unit', 501)"),
  ]);
});
afterEach(() => vi.restoreAllMocks());

const ticketsBy = (accountId: number) =>
  env.DB.prepare("SELECT * FROM tickets WHERE created_by = ?").bind(accountId).all().then((r) => r.results as any[]);
const eventsFor = (ticketId: number) =>
  env.DB.prepare("SELECT * FROM events WHERE subject_type='ticket' AND subject_id=? ORDER BY id")
    .bind(ticketId)
    .all()
    .then((r) => r.results as any[]);

const msg = (rawKey: string, inbox: TriageEmail["inbox"], subject: string): TriageEmail => ({
  inbox,
  accountId: 70,
  from: "res@lsq.test",
  subject,
  rawKey,
});

describe("ai Worker — triage (D32)", () => {
  it("opens an urgent complaint, notifies the inbox's people, and advises the sender", async () => {
    const h = makeEnv(
      { "triage/concierge/t1": "Subject: Threats\r\n\r\nMen are threatening residents in the lobby." },
      { category: "complaint", urgent: true }
    );
    const m = msg("triage/concierge/t1", "concierge", "Threats");
    await triageInbound(h, m);
    await triageInbound(h, m); // queue retry → no second ticket or mail

    const [t, ...more] = await ticketsBy(70);
    expect(more).toEqual([]);
    expect(t).toMatchObject({ title: "Threats", category: "complaint", classified_by: "ai", unit_id: 501, building_id: 1 });

    const evs = await eventsFor(t.id);
    expect(evs.map((e) => [e.type, e.actor_role, e.source])).toEqual([
      ["comment", "resident", "email"],
      ["classify", "system", "ai"],
      ["comment", "system", "ai"], // the advice: logged, but no staff SLA stop
    ]);
    expect(evs[0]).toMatchObject({ actor_id: 70, body: "Men are threatening residents in the lobby.", ai_summary: "short summary" });
    expect(evs[1].to_value).toBe("complaint");
    const configured = await env.DB.prepare("SELECT value FROM config WHERE key = 'urgent_reply'").first<{ value: string }>();
    expect(evs[2].body).toBe(configured!.value); // the seeded, board-editable reply

    const address = `${t.id}@ticket.lansburysquare.co.uk`;
    expect(mail).toHaveLength(2);
    expect(mail[0]).toMatchObject({
      from: { email: "new@ticket.lansburysquare.co.uk" }, // dropped when it returns via CC
      to: [{ email: "desk@gmail.com" }, { email: "night@gmail.com" }],
      cc: [{ email: address }],
      subject: `[#${t.id}] Threats`,
    });
    expect(mail[1]).toMatchObject({
      from: { email: "ops@lansburysquare.co.uk" },
      to: [{ email: "res@lsq.test" }],
      reply_to: { email: address },
    });
    expect(mail[1].text).toBe(evs[2].body); // what was sent is what was logged
  });

  it("opens an unclassified ticket when the model answers off-schema, without advice", async () => {
    const h = makeEnv({ k: "Subject: Gym\r\n\r\nWhen does the gym open?" }, { category: "made_up", urgent: "yes" });
    let acked = false;
    await worker.queue!(
      { messages: [{ body: msg("k", "management", "Gym"), ack: () => (acked = true), retry: () => {} }] } as any,
      h
    );
    expect(acked).toBe(true);

    const [t] = await ticketsBy(70);
    expect(t).toMatchObject({ category: null, classified_by: "ai" });
    const evs = await eventsFor(t.id);
    expect(evs.map((e) => e.type)).toEqual(["comment", "classify"]);
    expect(mail.map((m) => m.to)).toEqual([[{ email: "pm@agentco.co.uk" }]]); // notice only
  });
});
