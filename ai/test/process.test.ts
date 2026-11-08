import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import worker from "../src/index";
import { processInbound } from "../src/process";
import type { InboundEmail } from "../../common/queue";

// Fake R2 seeded with the raw message; AI omitted → summary skipped.
function makeEnv(raw: Record<string, string>) {
  const store = new Map<string, string | ArrayBuffer | Uint8Array>(Object.entries(raw));
  const env2 = {
    DB: env.DB,
    AI: undefined,
    RAW: {
      get: async (k: string) =>
        store.has(k) ? { arrayBuffer: async () => new Response(store.get(k)!).arrayBuffer() } : null,
      put: async (k: string, v: ArrayBuffer | Uint8Array) => void store.set(k, v),
    },
  } as any;
  return { store, env: env2 };
}

const attachmentsFor = (eventId: number) =>
  env.DB.prepare("SELECT kind, filename, content_type, size, r2_key FROM attachments WHERE event_id = ? ORDER BY id")
    .bind(eventId)
    .all()
    .then((r) => r.results as any[]);

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
  it("records a comment from the R2 body, attributes a known account, and keeps the original", async () => {
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
    expect(h.store.has(key)).toBe(true); // raw kept as the comment's original (D28)
    expect((await attachmentsFor(ev.id)).map((a) => [a.kind, a.r2_key])).toEqual([["original", key]]);
  });

  it("logs an unknown sender and honours the 'no ai' opt-out", async () => {
    const key = "inbound/1234/def";
    const h = makeEnv({ [key]: rawMime("Fixed it.") });
    const msg: InboundEmail = { ticketId: 1234, from: "Stranger@nowhere.io", subject: "done NO AI", rawKey: key };
    await processInbound(h.env, msg);

    const [ev] = await eventsFor(1234);
    expect(ev.actor_email).toBe("stranger@nowhere.io");
    expect(ev.actor_role).toBe("contractor"); // unknown business domain (D29)
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

  it("marks enquiry_sent when staff email a contractor, not when a resident does", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO tickets (id, title, status, classified_by, created_at) VALUES (1235, 'Door', 'open', 'agent', '2026-11-02')"),
      env.DB.prepare("INSERT INTO organizations (id, name, kind) VALUES (90, 'Fixit', 'contractor')"),
      env.DB.prepare("INSERT INTO senders (match_type, match_value, org_id, status, first_seen, last_seen) VALUES ('domain', 'fixit.co.uk', 90, 'linked', 'x', 'x')"),
      env.DB.prepare("INSERT INTO accounts (id, email, name) VALUES (91, 'sam@agentco.co.uk', 'Sam')"),
      env.DB.prepare("INSERT INTO grants (account_id, role_key, scope_type, scope_id) VALUES (91, 'agent', 'estate', NULL)"),
      env.DB.prepare("INSERT INTO accounts (id, email, name) VALUES (92, 'concierge@lsq.test', 'Con')"),
      env.DB.prepare("INSERT INTO grants (account_id, role_key, scope_type, scope_id) VALUES (92, 'site_staff', 'estate', NULL)"),
    ]);
    const raw = "From: x\r\nTo: Info <info@fixit.co.uk>\r\nCc: 1235@ticket.lansburysquare.co.uk\r\n\r\nPlease attend.";
    const markers = async () => (await eventsFor(1235)).filter((e) => e.type === "marker");

    await processInbound(makeEnv({ r1: raw }).env, { ticketId: 1235, from: "sam@agentco.co.uk", subject: "s", rawKey: "r1" });
    expect((await markers()).map((e) => [e.to_value, e.actor_role])).toEqual([["enquiry_sent", "agent"]]);

    await processInbound(makeEnv({ r2: raw }).env, { ticketId: 1235, from: "res@lsq.test", subject: "s", rawKey: "r2" });
    expect((await markers()).length).toBe(1);

    await processInbound(makeEnv({ r3: raw }).env, { ticketId: 1235, from: "concierge@lsq.test", subject: "s", rawKey: "r3" });
    expect((await markers()).map((e) => e.actor_role)).toEqual(["agent", "site_staff"]);
  });

  it("parses multipart mail into clean text, stores attachments, and ignores a retry (D28)", async () => {
    const raw = [
      "From: Res <res2@lsq.test>",
      "To: 1234@ticket.lansburysquare.co.uk",
      "Subject: photo",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="b1"',
      "",
      "--b1",
      'Content-Type: multipart/alternative; boundary="b2"',
      "",
      "--b2",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "See the attached photo.",
      "--b2",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>See the <b>attached</b> photo.</p>",
      "--b2--",
      "--b1",
      'Content-Type: image/png; name="leak photo.png"',
      'Content-Disposition: attachment; filename="leak photo.png"',
      "Content-Transfer-Encoding: base64",
      "",
      btoa("PNGDATA"),
      "--b1--",
      "",
    ].join("\r\n");
    const key = "inbound/1234/mp1";
    const h = makeEnv({ [key]: raw });
    const msg: InboundEmail = { ticketId: 1234, from: "res2@lsq.test", subject: "photo", rawKey: key };
    await processInbound(h.env, msg);
    await processInbound(h.env, msg); // queue retry → no second comment

    const comments = (await eventsFor(1234)).filter((e) => e.type === "comment");
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toBe("See the attached photo.");
    const atts = await attachmentsFor(comments[0].id);
    expect(atts).toEqual([
      expect.objectContaining({ kind: "original", content_type: "message/rfc822", r2_key: key }),
      { kind: "file", filename: "leak photo.png", content_type: "image/png", size: 7, r2_key: "attachments/1234/mp1/0-leak_photo.png" },
    ]);
    expect(new TextDecoder().decode(h.store.get("attachments/1234/mp1/0-leak_photo.png") as Uint8Array)).toBe("PNGDATA");
  });

  it("defaults unknown personal-domain senders to resident, and resolves extra account addresses (D29)", async () => {
    const h = makeEnv({ p1: rawMime("from gmail"), p2: rawMime("from alt") });
    await processInbound(h.env, { ticketId: 1234, from: "someone@gmail.com", subject: "s", rawKey: "p1" });

    const acct = await env.DB.prepare(
      "INSERT INTO accounts (email, name, active) VALUES ('primary@lsq.test', 'Pat', 1) RETURNING id"
    ).first<{ id: number }>();
    await env.DB.prepare("INSERT INTO account_emails (email, account_id, added_at) VALUES ('alt@hotmail.com', ?, 'x')")
      .bind(acct!.id)
      .run();
    await processInbound(h.env, { ticketId: 1234, from: "alt@hotmail.com", subject: "s", rawKey: "p2" });

    const [gmail, alt] = await eventsFor(1234);
    expect([gmail.actor_email, gmail.actor_role]).toEqual(["someone@gmail.com", "resident"]);
    expect([alt.actor_id, alt.actor_role]).toEqual([acct!.id, "resident"]); // no grants → resident
  });
});
