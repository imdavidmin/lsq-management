import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { app } from "../src/app";
import { addGrant, login } from "./helpers";

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

describe("engagement — surveys", () => {
  it("one vote per unit: second resident of the same unit is rejected 409", async () => {
    const board = await login("s-board@lsq.test", "board", "estate", null);
    const survey = (await (await post("/api/surveys", board.cookie, { service_year: 2026 })).json()) as any;

    const r1 = await login("s-r1@lsq.test", "resident", "unit", 101);
    const first = await post(`/api/surveys/${survey.id}/responses`, r1.cookie, { answers: { cleanliness: 4 } });
    expect(first.status).toBe(201);
    expect((await first.json() as any).answers.cleanliness).toBe(4);

    // Second resident of unit 101 — unit already voted.
    const r2 = await login("s-r2@lsq.test", "resident", "unit", 101);
    const second = await post(`/api/surveys/${survey.id}/responses`, r2.cookie, { answers: { cleanliness: 2 } });
    expect(second.status).toBe(409);

    // Only one response + one ballot recorded.
    const responses = (await (await req(`/api/surveys/${survey.id}/responses`, board.cookie)).json()) as any[];
    expect(responses.length).toBe(1);
  });

  it("requires unit_id when the caller has several eligible units", async () => {
    const board = await login("s-board2@lsq.test", "board", "estate", null);
    const survey = (await (await post("/api/surveys", board.cookie, { service_year: 2026 })).json()) as any;

    const r = await login("s-multi@lsq.test", "resident", "unit", 101);
    await addGrant(r.id, "resident", "unit", 201); // now two eligible units

    const ambiguous = await post(`/api/surveys/${survey.id}/responses`, r.cookie, { answers: { cleanliness: 5 } });
    expect(ambiguous.status).toBe(400);

    const chosen = await post(`/api/surveys/${survey.id}/responses`, r.cookie, {
      unit_id: 201,
      answers: { cleanliness: 5 },
    });
    expect(chosen.status).toBe(201);
  });

  it("rejects a response on a closed survey", async () => {
    const board = await login("s-board3@lsq.test", "board", "estate", null);
    const survey = (await (await post("/api/surveys", board.cookie, { service_year: 2026 })).json()) as any;
    await patch(`/api/surveys/${survey.id}`, board.cookie, { closed: true });

    const r = await login("s-r3@lsq.test", "resident", "unit", 101);
    const res = await post(`/api/surveys/${survey.id}/responses`, r.cookie, { answers: { cleanliness: 3 } });
    expect(res.status).toBe(409);
  });

  it("stores responses anonymously (no unit/account link) and gate stays unmet below N", async () => {
    const board = await login("s-board4@lsq.test", "board", "estate", null);
    const survey = (await (await post("/api/surveys", board.cookie, { service_year: 2026 })).json()) as any;
    const r = await login("s-r4@lsq.test", "resident", "unit", 101);
    await post(`/api/surveys/${survey.id}/responses`, r.cookie, { answers: { cleanliness: 4 } });

    // Response row carries no identity columns.
    const cols = await env.DB.prepare(`PRAGMA table_info(survey_responses)`).all();
    const names = (cols.results as any[]).map((c) => c.name);
    expect(names).not.toContain("account_id");
    expect(names).not.toContain("unit_id");

    const list = (await (await req("/api/surveys", board.cookie)).json()) as any[];
    const s = list.find((x) => x.id === survey.id);
    expect(s.response_count).toBe(1);
    expect(s.scoring_gate_met).toBe(false); // 1 < 50
  });

  it("outlier flagging is audited on the event spine", async () => {
    const board = await login("s-board5@lsq.test", "board", "estate", null);
    const survey = (await (await post("/api/surveys", board.cookie, { service_year: 2026 })).json()) as any;
    const r = await login("s-r5@lsq.test", "resident", "unit", 101);
    await post(`/api/surveys/${survey.id}/responses`, r.cookie, { answers: { cleanliness: 1 } });
    const resp = ((await (await req(`/api/surveys/${survey.id}/responses`, board.cookie)).json()) as any[])[0];

    const flagged = (await (await patch(
      `/api/surveys/${survey.id}/responses/${resp.id}`,
      board.cookie,
      { is_outlier: true }
    )).json()) as any;
    expect(flagged.is_outlier).toBe(true);

    const ev = await env.DB.prepare(
      "SELECT * FROM events WHERE subject_type = 'survey_response' AND subject_id = ?"
    ).bind(resp.id).first<any>();
    expect(ev.to_value).toBe("is_outlier:1");
  });
});

const put = (p: string, cookie: string, b: unknown) => req(p, cookie, { method: "PUT", body: JSON.stringify(b) });

describe("engagement — site info", () => {
  it("admin can save site info; residents can read but not save", async () => {
    const admin = await login("si-admin@lsq.test", "admin", "estate", null);
    const saved = (await (await put("/api/site-info", admin.cookie, { value: "## Contacts\n020 7000 0000" })).json()) as any;
    expect(saved.value).toContain("020 7000 0000");
    expect(saved.updated_at).toBeTruthy();

    const resident = await login("si-res@lsq.test", "resident", "unit", 101);
    const read = (await (await req("/api/site-info", resident.cookie)).json()) as any;
    expect(read.value).toContain("020 7000 0000");

    const denied = await put("/api/site-info", resident.cookie, { value: "hacked" });
    expect(denied.status).toBe(403);
  });
});
