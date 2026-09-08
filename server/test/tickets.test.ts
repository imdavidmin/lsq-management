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
const post = (path: string, cookie: string, b: unknown) =>
  req(path, cookie, { method: "POST", body: JSON.stringify(b) });

// Two units in two buildings so scope filtering is observable.
beforeEach(async () => {
  await env.DB.exec("INSERT OR IGNORE INTO buildings (id, name) VALUES (2, 'Building B')");
  await env.DB.exec("INSERT OR IGNORE INTO units (id, building_id, label) VALUES (101, 1, 'Flat 101')");
  await env.DB.exec("INSERT OR IGNORE INTO units (id, building_id, label) VALUES (201, 2, 'Flat 201')");
});

describe("tickets", () => {
  it("creates an unclassified ticket (no category chosen) with a comment + classify event", async () => {
    const { id, cookie } = await login("res1@lsq.test", "resident", "unit", 101);
    const res = await post("/api/tickets", cookie, {
      title: "Leaking tap",
      description: "Kitchen tap drips overnight",
      unit_id: 101,
    });
    expect(res.status).toBe(201);
    const t = (await res.json()) as any;
    expect(t.status).toBe("open");
    expect(t.created_by).toBe(id);
    expect(t.category).toBeNull(); // no category chosen → agent will categorise
    expect(t.needs_contractor).toBe(false); // serialized as boolean

    const detail = await (await req(`/api/tickets/${t.id}`, cookie)).json() as any;
    const types = detail.events.map((e: any) => e.type).sort();
    expect(types).toEqual(["classify", "comment"]);
    const comment = detail.events.find((e: any) => e.type === "comment");
    expect(comment.body).toBe("Kitchen tap drips overnight");
  });

  it("stores a creator-chosen category and stamps classified_by with their role", async () => {
    const { cookie } = await login("res-cat@lsq.test", "resident", "unit", 101);
    const t = (await (await post("/api/tickets", cookie, {
      title: "Bins overflowing",
      description: "communal bins full",
      category: "cleaning",
      unit_id: 101,
    })).json()) as any;
    expect(t.category).toBe("cleaning");
    expect(t.classified_by).toBe("resident"); // set by the creator, not AI

    const events = (await (await req(`/api/tickets/${t.id}/events`, cookie)).json()) as any[];
    const classify = events.find((e) => e.type === "classify");
    expect(classify.to_value).toBe("cleaning");
    expect(classify.source).toBe("ui"); // no AI involved
  });

  it("scopes the list: resident sees only in-scope tickets, agent sees all", async () => {
    const a = await login("res-a@lsq.test", "resident", "unit", 101);
    const b = await login("res-b@lsq.test", "resident", "unit", 201);
    const agent = await login("agent@lsq.test", "agent", "estate", null);

    await post("/api/tickets", a.cookie, { title: "A issue", description: "x", unit_id: 101 });
    await post("/api/tickets", b.cookie, { title: "B issue", description: "y", unit_id: 201 });

    const aList = (await (await req("/api/tickets", a.cookie)).json()) as any;
    expect(aList.total).toBe(1);
    expect(aList.data[0].unit_id).toBe(101);
    // List embeds each ticket's timeline; creation always logs a classify event.
    expect(aList.data[0].events.some((e: any) => e.type === "classify")).toBe(true);

    const agentList = (await (await req("/api/tickets", agent.cookie)).json()) as any;
    expect(agentList.total).toBe(2);
  });

  it("blocks a resident from another unit's ticket (403)", async () => {
    const a = await login("res-c@lsq.test", "resident", "unit", 101);
    const b = await login("res-d@lsq.test", "resident", "unit", 201);
    const created = (await (await post("/api/tickets", a.cookie, {
      title: "A only",
      description: "x",
      unit_id: 101,
    })).json()) as any;

    const res = await req(`/api/tickets/${created.id}`, b.cookie);
    expect(res.status).toBe(403);
  });

  it("reassigning category logs a classify event and sets classified_by=agent", async () => {
    const res = await login("res-e@lsq.test", "resident", "unit", 101);
    const agent = await login("agent2@lsq.test", "agent", "estate", null);
    const t = (await (await post("/api/tickets", res.cookie, {
      title: "Broken light",
      description: "hallway",
      unit_id: 101,
    })).json()) as any;

    const patched = (await (await req(`/api/tickets/${t.id}`, agent.cookie, {
      method: "PATCH",
      body: JSON.stringify({ category: "communal_repair" }),
    })).json()) as any;
    expect(patched.category).toBe("communal_repair");
    expect(patched.classified_by).toBe("agent");

    const events = (await (await req(`/api/tickets/${t.id}/events`, agent.cookie)).json()) as any[];
    const classify = events.filter((e) => e.type === "classify");
    const reassign = classify.find((e) => e.to_value === "communal_repair");
    expect(reassign.from_value).toBeNull();
  });

  it("residents cannot PATCH (no ticket:update permission)", async () => {
    const res = await login("res-f@lsq.test", "resident", "unit", 101);
    const t = (await (await post("/api/tickets", res.cookie, {
      title: "x",
      description: "y",
      unit_id: 101,
    })).json()) as any;
    const patch = await req(`/api/tickets/${t.id}`, res.cookie, {
      method: "PATCH",
      body: JSON.stringify({ status: "resolved" }),
    });
    expect(patch.status).toBe(403);
  });

  it("status change to resolved stamps resolved_at and logs a status event", async () => {
    const res = await login("res-g@lsq.test", "resident", "unit", 101);
    const agent = await login("agent3@lsq.test", "agent", "estate", null);
    const t = (await (await post("/api/tickets", res.cookie, {
      title: "x",
      description: "y",
      unit_id: 101,
    })).json()) as any;
    const patched = (await (await req(`/api/tickets/${t.id}`, agent.cookie, {
      method: "PATCH",
      body: JSON.stringify({ status: "resolved" }),
    })).json()) as any;
    expect(patched.status).toBe("resolved");
    expect(patched.resolved_at).not.toBeNull();

    const events = (await (await req(`/api/tickets/${t.id}/events`, agent.cookie)).json()) as any[];
    expect(events.some((e) => e.type === "status" && e.to_value === "resolved")).toBe(true);
  });

  it("adds a UI comment via POST /tickets/{id}/events", async () => {
    const res = await login("res-h@lsq.test", "resident", "unit", 101);
    const t = (await (await post("/api/tickets", res.cookie, {
      title: "x",
      description: "y",
      unit_id: 101,
    })).json()) as any;
    const ev = (await (await post(`/api/tickets/${t.id}/events`, res.cookie, {
      body: "any update",
    })).json()) as any;
    expect(ev.type).toBe("comment");
    expect(ev.source).toBe("ui");
    expect(ev.body).toBe("any update");
  });
});
