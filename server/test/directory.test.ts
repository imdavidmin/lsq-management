import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
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
    const res = await post("/api/accounts", board.cookie, { email: "New@lsq.test", name: "New" });
    expect(res.status).toBe(201);
    expect((await res.json() as any).active).toBe(true);
    const dup = await post("/api/accounts", board.cookie, { email: "new@lsq.test", name: "Dup" });
    expect(dup.status).toBe(409);
  });

  it("minimises the list, reveal-gates PII on detail, and audits reads (GDPR)", async () => {
    const board = await login("board-pii@lsq.test", "board", "estate", null);
    const acct = (await (await post("/api/accounts", board.cookie, {
      email: "resident-pii@lsq.test",
      name: "Reese Ident",
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

  it("invites a resident with a unit → creates a resident grant", async () => {
    const board = await login("board-inv@lsq.test", "board", "estate", null);
    const acct = (await (await post("/api/accounts", board.cookie, {
      email: "newres@lsq.test",
      name: "New Resident",
      unit_id: 101,
    })).json()) as any;
    expect(acct.id).toBeTruthy();
    const grants = (await (await req(`/api/accounts/${acct.id}/grants`, board.cookie)).json()) as any[];
    expect(grants).toContainEqual(
      expect.objectContaining({ role_key: "resident", scope_type: "unit", scope_id: 101 }),
    );
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
      name: "G",
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
