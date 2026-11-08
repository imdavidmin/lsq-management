import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import worker from "../src/index";
import type { InboundEmail, QueuedEmail } from "../../common/queue";

const DOMAIN = "ticket.lansburysquare.co.uk";

// Fakes for the queue + R2 bindings; DB is the real migrated pool D1.
function fakes() {
  const sent: QueuedEmail[] = [];
  const r2 = new Map<string, ArrayBuffer>();
  return {
    sent,
    r2,
    env: {
      DB: env.DB,
      INBOUND: { send: async (m: QueuedEmail) => void sent.push(m) },
      RAW: { put: async (k: string, v: ArrayBuffer) => void r2.set(k, v) },
      TICKET_EMAIL_DOMAIN: DOMAIN,
      MAIL_DOMAIN: "lansburysquare.co.uk",
    } as any,
  };
}

function craft(from: string, to: string, subject = "Re: ticket", body = "hello", headers: Record<string, string> = {}) {
  let rejected: string | null = null;
  const message = {
    from,
    to,
    headers: new Headers({ subject, ...headers }),
    raw: new Response(`Subject: ${subject}\r\n\r\n${body}`).body,
    setReject: (r: string) => (rejected = r),
    forward: async (to: string) => {
      if (to.startsWith("unverified")) throw new Error("destination not verified");
      forwarded.push(to);
    },
  } as any;
  const forwarded: string[] = [];
  return { message, reject: () => rejected, forwarded };
}

beforeEach(async () => {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tickets (id, title, status, classified_by, created_at) VALUES (1234, 'Leak', 'open', 'agent', ?)"
  ).bind(new Date().toISOString()).run();
});

describe("email Worker", () => {
  it("rejects unknown and non-numeric ticket addresses without enqueuing", async () => {
    const f = fakes();
    const bad = craft("x@y.com", `9999@${DOMAIN}`);
    await worker.email!(bad.message, f.env);
    expect(bad.reject()).toMatch(/no such ticket/);

    const nan = craft("x@y.com", `nope@${DOMAIN}`);
    await worker.email!(nan.message, f.env);
    expect(nan.reject()).toMatch(/unrecognised/);

    // A real ticket id on the main domain doesn't thread (D25): it's an alias lookup.
    const apex = craft("x@y.com", "1234@lansburysquare.co.uk");
    await worker.email!(apex.message, f.env);
    expect(apex.reject()).toMatch(/no such address/);

    expect(f.sent.length).toBe(0);
    expect(f.r2.size).toBe(0);
  });

  it("stashes raw in R2 and enqueues the key for a valid ticket", async () => {
    const f = fakes();
    const { message, reject } = craft("Sender@Acme.com", `1234@${DOMAIN}`, "Update");
    await worker.email!(message, f.env);

    expect(reject()).toBeNull();
    expect(f.sent.length).toBe(1);
    const msg = f.sent[0] as InboundEmail;
    expect(msg.ticketId).toBe(1234);
    expect(msg.from).toBe("sender@acme.com"); // lowercased
    expect(msg.subject).toBe("Update");
    expect(f.r2.has(msg.rawKey)).toBe(true); // raw staged under the enqueued key
  });

  it("forwards a main-domain alias to every destination, skipping failures (D26)", async () => {
    await env.DB.prepare("INSERT INTO config (key, value) VALUES ('mail_aliases', ?)")
      .bind(JSON.stringify({ board: ["a@gmail.com", "unverified@x.com", "b@live.com"] }))
      .run();
    const f = fakes();

    const board = craft("x@y.com", "Board@lansburysquare.co.uk");
    await worker.email!(board.message, f.env);
    expect(board.reject()).toBeNull();
    expect(board.forwarded).toEqual(["a@gmail.com", "b@live.com"]);

    const unknown = craft("x@y.com", "nobody@lansburysquare.co.uk");
    await worker.email!(unknown.message, f.env);
    expect(unknown.reject()).toMatch(/no such address/);
    expect(f.sent.length).toBe(0); // aliases never touch the ticket queue
  });

  it("drops our own notice CCing a ticket address without logging it (D32)", async () => {
    const f = fakes();
    const own = craft("bounce@mta.lansburysquare.co.uk", `1234@${DOMAIN}`, "[#1234] Leak", "notice", {
      from: `Lansbury Square <new@${DOMAIN}>`,
    });
    await worker.email!(own.message, f.env);
    expect(own.reject()).toBeNull(); // accepted, not bounced
    expect(f.sent.length).toBe(0);

    // Other mail from our own sending address is still logged.
    const ops = craft("ops@lansburysquare.co.uk", `1234@${DOMAIN}`, "Re", "hi", { from: "ops@lansburysquare.co.uk" });
    await worker.email!(ops.message, f.env);
    expect(f.sent.length).toBe(1);
  });

  it("queues mail to a triage inbox from a known account, and only forwards the rest (D32)", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO config (key, value) VALUES ('mail_aliases', ?)").bind(
        JSON.stringify({ concierge: ["desk@gmail.com"], board: ["b@gmail.com"] })
      ),
      env.DB.prepare("INSERT INTO accounts (id, email, name, active) VALUES (77, 'res@lsq.test', 'Res', 1)"),
    ]);
    const f = fakes();

    const known = craft("Res@lsq.test", "Concierge@lansburysquare.co.uk", "Bins overflowing");
    await worker.email!(known.message, f.env);
    expect(known.forwarded).toEqual(["desk@gmail.com"]);
    expect(f.sent).toEqual([
      { inbox: "concierge", accountId: 77, from: "res@lsq.test", subject: "Bins overflowing", rawKey: expect.stringMatching(/^triage\/concierge\//) },
    ]);
    expect(f.r2.has((f.sent[0] as any).rawKey)).toBe(true);

    // Forwarded only: unknown sender, "no ai" opt-out, an auto-reply, a non-triage alias.
    for (const m of [
      craft("stranger@gmail.com", "concierge@lansburysquare.co.uk", "Hello"),
      craft("res@lsq.test", "concierge@lansburysquare.co.uk", "Bins NO AI"),
      craft("res@lsq.test", "concierge@lansburysquare.co.uk", "Out of office", "away", { "auto-submitted": "auto-replied" }),
      craft("res@lsq.test", "board@lansburysquare.co.uk", "Hello"),
    ]) {
      await worker.email!(m.message, f.env);
      expect(m.forwarded.length).toBe(1);
    }
    expect(f.sent.length).toBe(1);
  });
});
