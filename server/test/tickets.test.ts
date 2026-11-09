import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, vi } from "vitest";
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
    expect(t.reply_to).toBe(`${t.id}@ticket.lansburysquare.co.uk`); // D25

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

  it("emails a UI comment to the creator when someone else posts it (D33)", async () => {
    const mail: any[] = [];
    let status = 202;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      mail.push(JSON.parse(String(init?.body)));
      return new Response(null, { status });
    });
    const send = (path: string, cookie: string, b: unknown) =>
      app.request(
        path,
        { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(b) },
        { ...env, MAILERSEND_API_KEY: "mlsn.test" }
      );
    const res = await login("res-n@lsq.test", "resident", "unit", 101);
    const agent = await login("ag-n@lsq.test", "agent", "estate", null);
    const t = (await (await post("/api/tickets", res.cookie, { title: "Leak", description: "y", unit_id: 101 })).json()) as any;

    expect((await send(`/api/tickets/${t.id}/events`, agent.cookie, { body: "Can you send a photo?" })).status).toBe(201);
    expect(mail).toHaveLength(1);
    const address = `${t.id}@ticket.lansburysquare.co.uk`;
    expect(mail[0]).toMatchObject({
      from: { email: "noreply@ticket.lansburysquare.co.uk" },
      to: [{ email: "res-n@lsq.test" }],
      reply_to: { email: address },
      subject: `Re: Leak [#${t.id}]`,
    });
    expect(mail[0].cc).toBeUndefined(); // the comment is already on the ticket
    expect(mail[0].text.startsWith("Can you send a photo?")).toBe(true);

    // The creator's own comment and a marker aren't emailed.
    await send(`/api/tickets/${t.id}/events`, res.cookie, { body: "Will do" });
    await send(`/api/tickets/${t.id}/markers`, agent.cookie, { marker: "attended", notes: "Looked at it" });
    expect(mail).toHaveLength(1);

    // MailerSend failing doesn't lose the comment.
    status = 500;
    expect((await send(`/api/tickets/${t.id}/events`, agent.cookie, { body: "Still there?" })).status).toBe(201);
    spy.mockRestore();
    const events = (await (await req(`/api/tickets/${t.id}/events`, agent.cookie)).json()) as any[];
    expect(events.some((e) => e.body === "Still there?")).toBe(true);
  });

  it("records an attended marker with notes; residents can't, other markers are rejected", async () => {
    const agent = await login("ag-m@lsq.test", "agent", "estate", null);
    const t = (await (await post("/api/tickets", agent.cookie, { title: "Door", description: "closer broken" })).json()) as any;
    const res = await post(`/api/tickets/${t.id}/markers`, agent.cookie, { marker: "attended", notes: "Closer replaced" });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ type: "marker", to_value: "attended", body: "Closer replaced", actor_role: "agent" });

    expect((await post(`/api/tickets/${t.id}/markers`, agent.cookie, { marker: "enquiry_sent", notes: "x" })).status).toBe(400);
    expect((await post(`/api/tickets/${t.id}/markers`, agent.cookie, { marker: "attended", notes: " " })).status).toBe(400);
    const res2 = await login("res-m@lsq.test", "resident", "estate", null);
    expect((await post(`/api/tickets/${t.id}/markers`, res2.cookie, { marker: "attended", notes: "x" })).status).toBe(403);
  });

  it("serves an email comment's attachments in scope, with sandboxing headers (D28/D29)", async () => {
    const a = await login("res-att@lsq.test", "resident", "unit", 101);
    const b = await login("res-att2@lsq.test", "resident", "unit", 201);
    const t = (await (await post("/api/tickets", a.cookie, { title: "Leak", description: "x", unit_id: 101 })).json()) as any;
    const other = (await (await post("/api/tickets", b.cookie, { title: "Other", description: "y", unit_id: 201 })).json()) as any;

    // An email comment from an address later linked to resident A (shown by name, role kept).
    await env.DB.prepare("INSERT INTO account_emails (email, account_id, added_at) VALUES ('alt@hotmail.com', ?, 'x')")
      .bind(a.id)
      .run();
    const ev = await env.DB.prepare(
      `INSERT INTO events (subject_type, subject_id, at, actor_email, actor_role, type, body, source)
         VALUES ('ticket', ?, '2026-11-08T10:00:00Z', 'alt@hotmail.com', 'resident', 'comment', 'See photo', 'email') RETURNING id`
    ).bind(t.id).first<{ id: number }>();
    await env.MAIL.put("attachments/x/1-photo.png", "PNGDATA");
    await env.MAIL.put("attachments/x/2-page.html", "<script>alert(1)</script>");
    const att = async (filename: string, type: string, key: string) =>
      (await env.DB.prepare(
        "INSERT INTO attachments (event_id, kind, filename, content_type, size, r2_key) VALUES (?, 'file', ?, ?, 7, ?) RETURNING id"
      ).bind(ev!.id, filename, type, key).first<{ id: number }>())!.id;
    const png = await att("photo.png", "image/png", "attachments/x/1-photo.png");
    const html = await att("page.html", "text/html", "attachments/x/2-page.html");

    const detail = (await (await req(`/api/tickets/${t.id}`, a.cookie)).json()) as any;
    const comment = detail.events.find((e: any) => e.id === ev!.id);
    expect(comment.actor_name).toBe("res-att@lsq.test"); // via account_emails
    expect(comment.actor_role).toBe("resident");
    expect(comment.attachments.map((x: any) => x.filename)).toEqual(["photo.png", "page.html"]);

    const img = await req(`/api/tickets/${t.id}/attachments/${png}`, a.cookie);
    expect(img.status).toBe(200);
    expect(await img.text()).toBe("PNGDATA");
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("content-disposition")).toMatch(/^inline/);
    expect(img.headers.get("x-content-type-options")).toBe("nosniff");
    expect(img.headers.get("content-security-policy")).toBe("sandbox");

    // HTML never renders on our origin.
    const page = await req(`/api/tickets/${t.id}/attachments/${html}`, a.cookie);
    expect(page.headers.get("content-type")).toBe("application/octet-stream");
    expect(page.headers.get("content-disposition")).toMatch(/^attachment/);
    await page.arrayBuffer(); // drain R2 bodies, or the pool's isolated storage fails

    expect((await req(`/api/tickets/${t.id}/attachments/${png}`, b.cookie)).status).toBe(403); // out of scope
    expect((await req(`/api/tickets/${other.id}/attachments/${png}`, b.cookie)).status).toBe(404); // wrong ticket
  });
});

