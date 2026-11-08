import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { app } from "../src/app";
import { login } from "./helpers";

const req = (path: string, cookie: string, init: RequestInit = {}) =>
  app.request(
    path,
    { ...init, headers: { "content-type": "application/json", cookie, ...(init.headers ?? {}) } },
    env
  );
const post = (p: string, cookie: string, b: unknown) => req(p, cookie, { method: "POST", body: JSON.stringify(b) });
const patch = (p: string, cookie: string, b: unknown) => req(p, cookie, { method: "PATCH", body: JSON.stringify(b) });

beforeEach(async () => {
  await env.DB.exec("INSERT OR IGNORE INTO buildings (id, name) VALUES (2, 'Building B')");
  await env.DB.exec("INSERT OR IGNORE INTO units (id, building_id, label) VALUES (101, 1, 'Flat 101')");
  await env.DB.exec("INSERT OR IGNORE INTO units (id, building_id, label) VALUES (201, 2, 'Flat 201')");
});

describe("directory", () => {
  it("creates an account and rejects a duplicate email (409)", async () => {
    const board = await login("board1@lsq.test", "board", "estate", null);
    const res = await post("/api/accounts", board.cookie, { email: "New@lsq.test", name: "New", role_key: "agent" });
    expect(res.status).toBe(201);
    expect((await res.json() as any).active).toBe(true);
    const dup = await post("/api/accounts", board.cookie, { email: "new@lsq.test", name: "Dup", role_key: "agent" });
    expect(dup.status).toBe(409);
  });

  it("minimises the list, reveal-gates PII on detail, and audits reads (GDPR)", async () => {
    const board = await login("board-pii@lsq.test", "board", "estate", null);
    const acct = (await (await post("/api/accounts", board.cookie, {
      email: "resident-pii@lsq.test",
      name: "Reese Ident", role_key: "agent"
    })).json()) as any;
    // Household grant: unit 101 lives in building 1.
    await post("/api/grants", board.cookie, {
      account_id: acct.id,
      role_key: "resident",
      scope_type: "unit",
      scope_id: 101,
    });

    // List is minimised: coarse building, no email, no unit.
    const list = (await (await req("/api/accounts", board.cookie)).json()) as any[];
    const row = list.find((a) => a.id === acct.id);
    expect(row.email).toBeUndefined();
    expect(row.buildings).toContain("Colston House");
    expect(JSON.stringify(row)).not.toContain("101");

    // Detail without reveal: no email, unit-scoped grant withheld.
    const plain = (await (await req(`/api/accounts/${acct.id}`, board.cookie)).json()) as any;
    expect(plain.email).toBeUndefined();
    expect(plain.grants.some((g: any) => g.scope_type === "unit")).toBe(false);

    // Reveal both: email present, unit grant present.
    const revealed = (await (await req(`/api/accounts/${acct.id}?reveal=email,units`, board.cookie)).json()) as any;
    expect(revealed.email).toBe("resident-pii@lsq.test");
    expect(revealed.grants.some((g: any) => g.scope_type === "unit" && g.scope_id === 101)).toBe(true);
    expect(revealed.units).toContain("Flat 101");

    // Bad reveal field → 400.
    expect((await req(`/api/accounts/${acct.id}?reveal=name`, board.cookie)).status).toBe(400);

    // Every read left an audit trail (no API reads it — query D1 directly).
    const log = (await env.DB.prepare(
      "SELECT action, resource_type, resource_id, detail FROM access_log WHERE account_id = ? ORDER BY id",
      ).bind(board.id).all()).results as any[];
    expect(log.some((r) => r.action === "list" && r.resource_type === "account")).toBe(true);
    const view = log.find((r) => r.action === "view" && r.resource_id === String(acct.id) && r.detail?.includes("email"));
    expect(view).toBeTruthy();
  });

  it("lets an account download who read its own PII, and nothing else (D22)", async () => {
    const board = await login("board-sar@lsq.test", "board", "estate", null);
    const res = await login("res-sar@lsq.test", "resident", "unit", 101);
    await req(`/api/accounts/${res.id}?reveal=email`, board.cookie);
    // Same id, different resource type → must not appear.
    await env.DB.prepare(
      "INSERT INTO access_log (at, account_id, action, resource_type, resource_id) VALUES ('2026-01-01', ?, 'view', 'ticket', ?)"
    ).bind(board.id, String(res.id)).run();

    const out = await req("/api/auth/me/access-log", res.cookie);
    expect(out.headers.get("content-disposition")).toContain("attachment");
    const lines = (await out.text()).trim().split("\r\n");
    expect(lines).toHaveLength(2); // header + the one account view
    expect(lines[1]).toContain('"view","board-sar@lsq.test","{""fields"":[""email""]}"');
  });

  it("invites by role: unit for residents/board (typed, found or created), estate for staff, and emails them", async () => {
    const board = await login("board-inv@lsq.test", "board", "estate", null);
    const log = vi.spyOn(console, "log");
    const invite = async (b: object) => {
      const res = await post("/api/accounts", board.cookie, b);
      expect(res.status).toBe(201);
      const { id } = (await res.json()) as any;
      const grants = (await (await req(`/api/accounts/${id}/grants`, board.cookie)).json()) as any[];
      return grants.map((g) => [g.role_key, g.scope_type, g.scope_id]);
    };

    // Existing unit matched case-insensitively.
    expect(await invite({ email: "newres@lsq.test", name: "Res", role_key: "resident", building_id: 1, unit: "flat 101" }))
      .toEqual([["resident", "unit", 101]]);
    expect(log.mock.calls.some(([m]) => String(m).includes("to=newres@lsq.test"))).toBe(true);

    // New unit created; board member also gets the estate-wide board grant.
    const g = await invite({ email: "newboard@lsq.test", name: "Bo", role_key: "board", building_id: 2, unit: "Flat 9Z" });
    const unit = await env.DB.prepare("SELECT id FROM units WHERE building_id = 2 AND label = 'Flat 9Z'").first<{ id: number }>();
    expect(g).toEqual([["resident", "unit", unit!.id], ["board", "estate", null]]);

    // Staff (e.g. concierge as agent): no building or unit.
    expect(await invite({ email: "concierge@lsq.test", name: "Con", role_key: "agent" })).toEqual([["agent", "estate", null]]);

    const bad = (b: object) => post("/api/accounts", board.cookie, { email: "x@lsq.test", name: "X", ...b });
    expect((await bad({ role_key: "resident" })).status).toBe(400); // resident needs a unit
    expect((await bad({ role_key: "agent", unit: "Flat 1" })).status).toBe(400); // unit needs a building
    expect((await bad({ role_key: "nope" })).status).toBe(400);
    log.mockRestore();
  });

  it("erases a person to 'Resident of …', scrubbing identifiers but keeping the ticket record (D30)", async () => {
    const board = await login("board-erase@lsq.test", "board", "estate", null);
    const agent = await login("agent-erase@lsq.test", "agent", "estate", null);
    const res = await login("leaver@lsq.test", "resident", "unit", 101);
    await post(`/api/accounts/${res.id}/emails`, board.cookie, { email: "leaver@gmail.com" });
    const t = (await (await post("/api/tickets", res.cookie, { title: "Tap", description: "drips", building_id: 1, unit_id: 101 })).json()) as any;

    // An email from their extra address before it was linked, with a raw original + a photo.
    const ev = await env.DB.prepare(
      `INSERT INTO events (subject_type, subject_id, at, actor_email, actor_role, type, body, source)
       VALUES ('ticket', ?, '2026-01-02', 'leaver@gmail.com', 'resident', 'comment', 'still dripping', 'email') RETURNING id`
    ).bind(t.id).first<{ id: number }>();
    for (const [kind, key] of [["original", "raw/leaver.eml"], ["file", "att/tap.jpg"]] as const) {
      await env.MAIL.put(key, "x");
      await env.DB.prepare(
        "INSERT INTO attachments (event_id, kind, filename, content_type, size, r2_key) VALUES (?, ?, ?, 'x', 1, ?)"
      ).bind(ev!.id, kind, key, key).run();
    }

    expect((await req(`/api/accounts/${board.id}`, board.cookie, { method: "DELETE" })).status).toBe(400); // not yourself
    expect((await req(`/api/accounts/${res.id}`, agent.cookie, { method: "DELETE" })).status).toBe(403);
    expect((await req(`/api/accounts/${res.id}`, board.cookie, { method: "DELETE" })).status).toBe(204);

    const timeline = (await (await req(`/api/tickets/${t.id}/events`, board.cookie)).json()) as any[];
    const theirs = timeline.filter((e) => e.type === "comment" || e.type === "created" || e.actor_id === res.id);
    expect(theirs.length).toBeGreaterThan(0);
    for (const e of theirs) expect([e.actor_name, e.actor_email]).toEqual(["Resident of Flat 101, Colston House", null]);
    const email = timeline.find((e) => e.id === ev!.id);
    expect(email.attachments.map((a: any) => a.kind)).toEqual(["file"]);
    expect(await env.MAIL.head("raw/leaver.eml")).toBeNull();
    expect(await env.MAIL.head("att/tap.jpg")).not.toBeNull();

    const row = await env.DB.prepare("SELECT email, active, erased_at FROM accounts WHERE id = ?").bind(res.id).first<any>();
    expect([row.email, row.active, !!row.erased_at]).toEqual([null, 0, true]);
    for (const table of ["grants", "sessions", "account_emails"]) {
      expect(await env.DB.prepare(`SELECT 1 FROM ${table} WHERE account_id = ?`).bind(res.id).first()).toBeNull();
    }
    expect(
      await env.DB.prepare("SELECT to_value FROM events WHERE subject_type = 'account' AND subject_id = ? AND type = 'erase'").bind(res.id).first()
    ).toEqual({ to_value: "Resident of Flat 101, Colston House" });

    // Gone from the directory, can't be revived, and can't sign in.
    const list = (await (await req("/api/accounts", board.cookie)).json()) as any[];
    expect(list.some((a) => a.id === res.id)).toBe(false);
    expect((await req(`/api/accounts/${res.id}`, board.cookie)).status).toBe(404);
    expect((await patch(`/api/accounts/${res.id}`, board.cookie, { active: true })).status).toBe(404);
    expect((await req(`/api/accounts/${res.id}`, board.cookie, { method: "DELETE" })).status).toBe(404);
    expect((await req("/api/auth/me", res.cookie)).status).toBe(401);
    const log = vi.spyOn(console, "log");
    await post("/api/auth/otp/request", "", { email: "leaver@lsq.test" });
    expect(log.mock.calls.some(([m]) => String(m).includes("to=leaver@lsq.test"))).toBe(false);
    log.mockRestore();
  });

  it("labels erased staff by role (and organization) instead of a unit (D30)", async () => {
    const board = await login("board-erase2@lsq.test", "board", "estate", null);
    const staff = await login("concierge-erase@lsq.test", "agent", "estate", null);
    await req(`/api/accounts/${staff.id}`, board.cookie, { method: "DELETE" });
    expect(await env.DB.prepare("SELECT name FROM accounts WHERE id = ?").bind(staff.id).first()).toEqual({ name: "Managing Agent" });
  });

  it("blocks a resident from directory management (403)", async () => {
    const resident = await login("res-dir@lsq.test", "resident", "unit", 101);
    expect((await req("/api/accounts", resident.cookie)).status).toBe(403);
    expect((await post("/api/buildings", resident.cookie, { name: "X" })).status).toBe(403);
  });

  it("ticket-scoped grant unlocks exactly one ticket (UJ-08)", async () => {
    const board = await login("board2@lsq.test", "board", "estate", null);
    const agent = await login("agent-dir@lsq.test", "agent", "estate", null);
    const outsider = await login("outsider@lsq.test", "resident", "unit", 201);

    const t = (await (await post("/api/tickets", agent.cookie, {
      title: "Roof leak",
      description: "communal",
      building_id: 1,
    })).json()) as any;

    // Out of scope before the share.
    expect((await req(`/api/tickets/${t.id}`, outsider.cookie)).status).toBe(403);

    const grant = await post("/api/grants", board.cookie, {
      account_id: outsider.id,
      role_key: "resident",
      scope_type: "ticket",
      scope_id: t.id,
    });
    expect(grant.status).toBe(201);

    // Now visible — and only this ticket.
    expect((await req(`/api/tickets/${t.id}`, outsider.cookie)).status).toBe(200);
    const list = (await (await req("/api/tickets", outsider.cookie)).json()) as any;
    expect(list.data.map((x: any) => x.id)).toEqual([t.id]);
  });

  it("grant requires scope_id unless estate (400)", async () => {
    const board = await login("board3@lsq.test", "board", "estate", null);
    const acct = (await (await post("/api/accounts", board.cookie, {
      email: "g@lsq.test",
      name: "G", role_key: "agent"
    })).json()) as any;
    const bad = await post("/api/grants", board.cookie, {
      account_id: acct.id,
      role_key: "resident",
      scope_type: "unit",
    });
    expect(bad.status).toBe(400);
  });

  it("replaces a role's permission set", async () => {
    const board = await login("board4@lsq.test", "board", "estate", null);
    await post("/api/roles", board.cookie, { key: "auditor", name: "Auditor" });
    const res = await req("/api/roles/auditor/permissions", board.cookie, {
      method: "PUT",
      body: JSON.stringify({ permissions: ["ticket:read", "score:read", "ticket:read"] }),
    });
    expect(res.status).toBe(200);
    expect((await res.json() as any).permissions).toEqual(["score:read", "ticket:read"]);
  });

  it("links an unknown sender so future emails resolve (UJ-07)", async () => {
    const board = await login("board5@lsq.test", "board", "estate", null);
    const org = (await (await post("/api/organizations", board.cookie, {
      name: "Acme Cleaning",
      kind: "contractor",
    })).json()) as any;

    // Simulate an unknown sender logged by the (future) email handler.
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO senders (match_type, match_value, org_id, status, hit_count, first_seen, last_seen)
         VALUES ('domain', 'acme.com', NULL, 'new', 3, ?, ?)`
    ).bind(now, now).run();

    const queue = (await (await req("/api/senders?status=new", board.cookie)).json()) as any[];
    expect(queue.map((s) => s.match_value)).toContain("acme.com");

    const sid = queue.find((s) => s.match_value === "acme.com").id;
    const linked = (await (await patch(`/api/senders/${sid}`, board.cookie, {
      org_id: org.id,
      status: "linked",
    })).json()) as any;
    expect(linked.org_id).toBe(org.id);
    expect(linked.status).toBe("linked");
  });

  it("creates a building + unit and lists units", async () => {
    const board = await login("board6@lsq.test", "board", "estate", null);
    const b = (await (await post("/api/buildings", board.cookie, { name: "Block C" })).json()) as any;
    const u = (await (await post("/api/units", board.cookie, { building_id: b.id, label: "Flat C1" })).json()) as any;
    expect(u.building_id).toBe(b.id);
    const units = (await (await req(`/api/buildings/${b.id}/units`, board.cookie)).json()) as any[];
    expect(units.map((x) => x.label)).toEqual(["Flat C1"]);
  });
});

describe("account emails + linking senders (D29)", () => {
  it("adds and removes extra addresses, unique across primary and extra, revealed with email", async () => {
    const board = await login("board-ae@lsq.test", "board", "estate", null);
    const acct = (await (await post("/api/accounts", board.cookie, { email: "pat@lsq.test", name: "Pat", role_key: "agent" })).json()) as any;

    expect((await post(`/api/accounts/${acct.id}/emails`, board.cookie, { email: "Pat@Hotmail.com" })).status).toBe(204);
    expect((await post(`/api/accounts/${acct.id}/emails`, board.cookie, { email: "pat@hotmail.com" })).status).toBe(409);
    expect((await post(`/api/accounts/${acct.id}/emails`, board.cookie, { email: "board-ae@lsq.test" })).status).toBe(409); // someone's primary
    expect((await post("/api/accounts", board.cookie, { email: "pat@hotmail.com", name: "Dup", role_key: "agent" })).status).toBe(409); // someone's extra

    const detail = (await (await req(`/api/accounts/${acct.id}?reveal=email`, board.cookie)).json()) as any;
    expect(detail.emails).toEqual(["pat@hotmail.com"]);
    expect(((await (await req(`/api/accounts/${acct.id}`, board.cookie)).json()) as any).emails).toBeUndefined();

    const del = await req(`/api/accounts/${acct.id}/emails/pat@hotmail.com`, board.cookie, { method: "DELETE" });
    expect(del.status).toBe(204);

    const agent = await login("agent-ae@lsq.test", "agent", "estate", null);
    expect((await post(`/api/accounts/${acct.id}/emails`, agent.cookie, { email: "x@gmail.com" })).status).toBe(403);
  });

  it("links an unknown email sender to a person (agent may), but not a domain sender", async () => {
    const agent = await login("agent-link@lsq.test", "agent", "estate", null);
    const board = await login("board-link@lsq.test", "board", "estate", null);
    const acct = (await (await post("/api/accounts", board.cookie, { email: "res-link@lsq.test", name: "Res", role_key: "agent" })).json()) as any;
    const sender = (id: string, type: string, value: string) =>
      env.DB.prepare(
        "INSERT INTO senders (match_type, match_value, status, first_seen, last_seen) VALUES (?, ?, 'new', 'x', 'x') RETURNING id"
      ).bind(type, value).first<{ id: number }>();
    const email = await sender("e", "email", "res-alt@gmail.com");
    const domain = await sender("d", "domain", "acme.io");

    expect((await post(`/api/senders/${email!.id}/account`, agent.cookie, { account_id: acct.id })).status).toBe(204);
    expect(await env.DB.prepare("SELECT account_id FROM account_emails WHERE email = 'res-alt@gmail.com'").first()).toEqual({ account_id: acct.id });
    expect(await env.DB.prepare("SELECT 1 FROM senders WHERE id = ?").bind(email!.id).first()).toBeNull();

    expect((await post(`/api/senders/${domain!.id}/account`, agent.cookie, { account_id: acct.id })).status).toBe(400);
  });
});

describe("mail aliases (D26)", () => {
  afterEach(() => vi.restoreAllMocks());

  // Same app, with a CF token so the Email Routing calls go out (to a stub).
  const withCf = (path: string, cookie: string, init: RequestInit = {}) =>
    app.request(
      path,
      { ...init, headers: { "content-type": "application/json", cookie } },
      { ...env, CF_EMAIL_TOKEN: "test-token" }
    );
  function stubCf() {
    const calls: { method: string; url: string; body: any }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push({ method: init?.method ?? "GET", url, body: init?.body && JSON.parse(String(init.body)) });
      const result = (init?.method ?? "GET") === "GET"
        ? [{ email: "known@gmail.com", verified: "2026-11-01T00:00:00Z" }]
        : { id: "addr-1" };
      return Response.json({ success: true, result });
    });
    return calls;
  }

  const aliasesDoc = async () =>
    JSON.parse((await env.DB.prepare("SELECT value FROM config WHERE key = 'mail_aliases'").first<{ value: string }>())!.value);
  const put = (p: string, cookie: string, b: unknown) => req(p, cookie, { method: "PUT", body: JSON.stringify(b) });

  it("lets the agent read but not provision (board@ is the board's)", async () => {
    const agent = await login("agent-mail@lsq.test", "agent", "estate", null);
    expect((await req("/api/mail-aliases", agent.cookie)).status).toBe(200);
    expect((await put("/api/mail-aliases/board", agent.cookie, { forward_to: ["me@gmail.com"] })).status).toBe(403);
  });

  it("board writes the aliases doc, registers new destinations, audits, and deletes", async () => {
    const board = await login("board-mail@lsq.test", "board", "estate", null);
    const calls = stubCf();
    const res = await withCf("/api/mail-aliases/board", board.cookie, {
      method: "PUT",
      body: JSON.stringify({ forward_to: ["Known@gmail.com", "new@gmail.com"] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      local_part: "board",
      address: "board@lansburysquare.co.uk",
      forward_to: [
        { email: "known@gmail.com", verified: true },
        { email: "new@gmail.com", verified: false },
      ],
    });
    // The email Worker reads exactly this doc.
    expect(await aliasesDoc()).toEqual({ board: ["known@gmail.com", "new@gmail.com"] });

    // Only the unknown destination is registered (CF then emails it a link).
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.body)).toEqual([{ email: "new@gmail.com" }]);

    const ev = await env.DB.prepare(
      "SELECT type, actor_id, body, to_value FROM events WHERE subject_type = 'mail_alias'"
    ).first<any>();
    expect(ev).toEqual({ type: "config", actor_id: board.id, body: "board", to_value: '["known@gmail.com","new@gmail.com"]' });

    expect((await withCf("/api/mail-aliases/board", board.cookie, { method: "DELETE" })).status).toBe(204);
    expect(await aliasesDoc()).toEqual({});
    expect((await withCf("/api/mail-aliases/board", board.cookie, { method: "DELETE" })).status).toBe(404);
  });

  it("rejects ticket-shaped names and mail loops", async () => {
    const board = await login("board-mail2@lsq.test", "board", "estate", null);
    expect((await put("/api/mail-aliases/ops", board.cookie, { forward_to: ["a@gmail.com"] })).status).toBe(200);
    expect((await put("/api/mail-aliases/123", board.cookie, { forward_to: ["a@gmail.com"] })).status).toBe(400);
    for (const loop of ["x@lansburysquare.co.uk", "1@ticket.lansburysquare.co.uk"]) {
      expect((await put("/api/mail-aliases/loop", board.cookie, { forward_to: [loop] })).status).toBe(400);
    }
  });
});
