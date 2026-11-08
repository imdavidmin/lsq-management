import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { app } from "../src/app";
import { login } from "./helpers";
import { KIND_VALUES, STOP_KINDS, type SlaKind } from "../../common/sla";
import { instances, ticketPasses, type SlaDef, type SlaTicket } from "../src/lib/sla";

interface SlaRow {
  name: string;
  source: string;
  start_on: SlaKind;
  start_value: string | null;
  stop_on: SlaKind;
  stop_value: string | null;
}

// A kind with no values takes NULL; otherwise the value must be one it accepts.
const valid = (kind: SlaKind, value: string | null) =>
  KIND_VALUES[kind].length === 0 ? value === null : (KIND_VALUES[kind] as readonly string[]).includes(value ?? "");

describe("scoring — seeded SLAs (D21)", () => {
  it("every seeded SLA feeds an auto metric and uses the shared vocabulary", async () => {
    const { results } = await env.DB.prepare(
      "SELECT s.*, m.source FROM slas s JOIN metrics m ON m.key = s.metric_key"
    ).all<SlaRow>();
    expect(results.length).toBe(7);
    for (const s of results) {
      expect(s.source, s.name).toBe("auto");
      expect(valid(s.start_on, s.start_value), `${s.name} start`).toBe(true);
      expect(STOP_KINDS).toContain(s.stop_on);
      expect(valid(s.stop_on, s.stop_value), `${s.name} stop`).toBe(true);
    }
  });

  it("seeds the scoring settings into the config table", async () => {
    const { results } = await env.DB.prepare(
      "SELECT key, value FROM config WHERE key = 'service_year_start'"
    ).all<{ key: string; value: string }>();
    expect(results).toEqual([{ key: "service_year_start", value: "08-01" }]);
  });
});

const req = (path: string, cookie: string, method = "GET", b?: unknown) =>
  app.request(
    path,
    { method, headers: { "content-type": "application/json", cookie }, body: b === undefined ? undefined : JSON.stringify(b) },
    env
  );

describe("scoring — SLA + settings API", () => {
  const sla = {
    name: "Cleaning acknowledged",
    metric_key: "site.cleaning_tickets",
    category: "cleaning",
    start_on: "ticket_created",
    stop_on: "event_by",
    stop_value: "staff",
    budget_days: 1,
  };

  it("board creates and edits an SLA; each write is audited; agent can read, not write", async () => {
    const board = await login("sla-board@lsq.test", "board", "estate", null);
    const created = await req("/api/slas", board.cookie, "POST", sla);
    expect(created.status).toBe(201);
    const row = (await created.json()) as any;
    expect(row).toMatchObject({ ...sla, needs_contractor: null, start_value: null, repeats: false, active: true, description: null });

    const edited = (await (await req(`/api/slas/${row.id}`, board.cookie, "PATCH", { active: false, description: "Cleaning tickets get a staff reply." })).json()) as any;
    expect(edited).toMatchObject({ ...sla, active: false, description: "Cleaning tickets get a staff reply." });

    const { results } = await env.DB.prepare(
      "SELECT from_value, to_value FROM events WHERE subject_type = 'sla' AND subject_id = ? AND type = 'config' ORDER BY id"
    ).bind(row.id).all<{ from_value: string | null; to_value: string }>();
    expect(results.map((e) => [JSON.parse(e.from_value ?? "null")?.active ?? null, JSON.parse(e.to_value).active])).toEqual([
      [null, 1],
      [1, 0],
    ]);

    const agent = await login("sla-agent@lsq.test", "agent", "estate", null);
    expect(((await (await req("/api/slas", agent.cookie)).json()) as any[]).length).toBe(8);
    expect((await req(`/api/slas/${row.id}`, agent.cookie, "PATCH", { active: true })).status).toBe(403);
  });

  it("rejects values that don't fit their kind, non-auto metrics, and ticket_created as a stop", async () => {
    const board = await login("sla-bad@lsq.test", "board", "estate", null);
    const bad = [
      { ...sla, stop_value: "board" },
      { ...sla, start_value: "open" },
      { ...sla, metric_key: "fin.service_charge_accounts" },
      { ...sla, stop_on: "ticket_created", stop_value: null },
    ];
    for (const b of bad) expect((await req("/api/slas", board.cookie, "POST", b)).status, JSON.stringify(b)).toBe(400);
    // A partial edit is validated against the merged row.
    expect((await req("/api/slas/1", board.cookie, "PATCH", { stop_on: "marker" })).status).toBe(400);
  });

  it("settings: validated per key, unknown keys 404, residents read-only", async () => {
    const board = await login("cfg-board@lsq.test", "board", "estate", null);
    const ok = await req("/api/config/service_year_start", board.cookie, "PUT", { value: "09-01" });
    expect(((await ok.json()) as any).value).toBe("09-01");
    expect((await req("/api/config/service_year_start", board.cookie, "PUT", { value: "13-01" })).status).toBe(400);
    expect((await req("/api/config/site_info", board.cookie, "PUT", { value: "x" })).status).toBe(404);

    const resident = await login("cfg-res@lsq.test", "resident", "unit", 101);
    const keys = ((await (await req("/api/config", resident.cookie)).json()) as any[]).map((e) => e.key);
    expect(keys).toEqual(["service_year_start"]);
    expect((await req("/api/config/service_year_start", resident.cookie, "PUT", { value: "08-01" })).status).toBe(403);
  });
});

describe("scoring — metrics", () => {
  it("board bulk-edits metrics; blank clears description; agent can't", async () => {
    const board = await login("m-board@lsq.test", "board", "estate", null);
    // Move 1 point from window cleaning to HIU servicing so the total stays 100.
    const res = await req("/api/metrics", board.cookie, "PATCH", [
      { key: "con.hiu_servicing", weight: 0.04, description: "HIUs serviced" },
      { key: "con.window_cleaning", weight: 0.02 },
    ]);
    expect(res.status).toBe(200);
    const table = (await res.json()) as any[];
    expect(table.find((m) => m.key === "con.hiu_servicing")).toMatchObject({ weight: 0.04, description: "HIUs serviced", active: true });
    const cleared = await req("/api/metrics", board.cookie, "PATCH", [{ key: "con.hiu_servicing", description: "  " }]);
    expect(((await cleared.json()) as any[]).find((m) => m.key === "con.hiu_servicing").description).toBeNull();
    expect((await req("/api/metrics", board.cookie, "PATCH", [{ key: "nope.x", weight: 0.1 }])).status).toBe(404);

    const agent = await login("m-agent@lsq.test", "agent", "estate", null);
    expect((await req("/api/metrics", agent.cookie, "PATCH", [{ key: "con.hiu_servicing", weight: 1 }])).status).toBe(403);
  });

  it("rejects edits that break the whole-table rules and writes nothing", async () => {
    const board = await login("m-rules@lsq.test", "board", "estate", null);
    const before = await (await req("/api/metrics", board.cookie)).json();
    const bad = async (patches: unknown[], msg: string) => {
      const res = await req("/api/metrics", board.cookie, "PATCH", patches);
      expect(res.status).toBe(400);
      expect(((await res.json()) as any).message).toContain(msg);
    };
    // Valid row first, then one that breaks the sum: neither may land.
    await bad([{ key: "res.ticket_acknowledgement", description: "x" }, { key: "proj.project_timelines", weight: 0.2 }], "add up to 100");
    await bad([{ key: "res.ticket_acknowledgement", threshold: 4 }], "proportional threshold");
    await bad([{ key: "site.cleanliness", mode: "proportional" }], "proportional threshold");
    expect(await (await req("/api/metrics", board.cookie)).json()).toEqual(before);
  });
});

describe("scoring — metric values", () => {
  it("lists stored values for a year, newest first; empty is a 200", async () => {
    const agent = await login("mv-agent@lsq.test", "agent", "estate", null);
    expect(await (await req("/api/metric-values?year=2026", agent.cookie)).json()).toEqual([]);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO metric_values (metric_key, service_year, value, result, computed_at) VALUES ('con.window_cleaning', 2026, 1, 0, '2026-03-01')"),
      env.DB.prepare("INSERT INTO metric_values (metric_key, service_year, value, result, computed_at) VALUES ('con.window_cleaning', 2026, 2, 1, '2026-09-01')"),
      env.DB.prepare("INSERT INTO metric_values (metric_key, service_year, value, result, computed_at) VALUES ('con.window_cleaning', 2025, 2, 1, '2025-09-01')"),
    ]);
    const rows = (await (await req("/api/metric-values?year=2026", agent.cookie)).json()) as any[];
    expect(rows.map((r) => r.value)).toEqual([2, 1]);
    expect((await req("/api/metric-values?year=abc", agent.cookie)).status).toBe(400);
  });
});

// ---- evaluator (D21), dates from the plan's worked traces ------------------
const def = (o: Partial<SlaDef>): SlaDef => ({
  id: 1, category: null, needs_contractor: null, start_on: "ticket_created", start_value: null,
  stop_on: "event_by", stop_value: "staff", budget_days: 2, repeats: 0, ...o,
});
const ev = (at: string, actor_role: string | null, type = "comment", to_value: string | null = null) => ({ at, actor_role, type, to_value });
const ticket = (created_at: string, events: ReturnType<typeof ev>[], o: Partial<SlaTicket> = {}): SlaTicket => ({
  category: null, needs_contractor: 0, created_at, events, ...o,
});
const outcomes = (sla: SlaDef, t: SlaTicket, now: string) => instances(sla, t, now).map((i) => [i.outcome, i.days]);

describe("SLA evaluator", () => {
  const ack = def({});
  it("met, breached when stopped late, breached while open, running", () => {
    const now = "2026-11-30T00:00:00Z";
    expect(outcomes(ack, ticket("2026-11-02T09:00Z", [ev("2026-11-02T09:00Z", "resident"), ev("2026-11-04T10:00Z", "agent")]), now)).toEqual([["met", 2]]);
    // Trace 2: a resident comment doesn't stop it; the agent reply is 3 wd later.
    expect(outcomes(ack, ticket("2026-11-02T09:00Z", [ev("2026-11-03T09:00Z", "resident"), ev("2026-11-05T10:00Z", "agent")]), now)).toEqual([["breached", 3]]);
    expect(outcomes(ack, ticket("2026-11-02T09:00Z", []), now)).toEqual([["breached", 20]]);
    expect(outcomes(ack, ticket("2026-11-02T09:00Z", []), "2026-11-03T12:00:00Z")).toEqual([["running", 1]]);
    // Site staff count as staff (D31).
    expect(outcomes(ack, ticket("2026-11-02T09:00Z", [ev("2026-11-03T10:00Z", "site_staff")]), now)).toEqual([["met", 1]]);
  });

  it("a staff-created ticket is acknowledged at 0 wd; budgets skip weekends and holidays", () => {
    expect(outcomes(ack, ticket("2026-11-02T09:00Z", [ev("2026-11-02T09:00Z", "agent")]), "2026-12-01")).toEqual([["met", 0]]);
    const cleaning = def({ stop_on: "status", stop_value: "resolved", budget_days: 1 });
    const resolved = (at: string) => ticket("2026-12-24T10:00Z", [ev(at, "agent", "status", "resolved")]);
    expect(outcomes(cleaning, resolved("2026-12-29T10:00Z"), "2027-01-10")).toEqual([["met", 1]]); // trace 1, #102
    expect(outcomes(cleaning, resolved("2026-12-30T10:00Z"), "2027-01-10")).toEqual([["breached", 2]]);
  });

  it("repeats: one instance per start, each stopped by the next match strictly after it (trace 3)", () => {
    const followUp = def({ start_on: "status", start_value: "pending_3rd_party", budget_days: 5, repeats: 1 });
    const t = ticket("2026-11-02T09:00Z", [
      ev("2026-11-09T10:00Z", "agent", "status", "pending_3rd_party"), // A starts; can't stop itself
      ev("2026-11-13T10:00Z", "agent"),
      ev("2026-11-16T10:00Z", "agent", "status", "open"),
      ev("2026-11-18T10:00Z", "agent", "status", "pending_3rd_party"), // B starts
    ]);
    expect(outcomes(followUp, t, "2026-11-26T00:00Z")).toEqual([["met", 4], ["breached", 6]]);
    expect(outcomes(followUp, t, "2026-11-23T00:00Z")).toEqual([["met", 4], ["running", 3]]);
    expect(ticketPasses([followUp], t, "2026-11-26T00:00Z")).toBe(false);
    expect(ticketPasses([followUp], t, "2026-11-23T00:00Z")).toBe(true); // running B excluded
    expect(outcomes({ ...followUp, repeats: 0 }, t, "2026-11-26T00:00Z")).toEqual([["met", 4]]);
  });

  it("chase silent contractor: any agent follow-up within 6 wd of each enquiry, early or not (trace 6)", () => {
    const chase = def({ start_on: "marker", start_value: "enquiry_sent", budget_days: 6, repeats: 1 });
    const enquiry = (at: string) => [ev(at, "agent"), ev(at, "agent", "marker", "enquiry_sent")]; // email to contractor
    const t = ticket("2026-11-06T09:00Z", [...enquiry("2026-11-09T10:00Z"), ...enquiry("2026-11-12T10:00Z")]);
    expect(outcomes(chase, t, "2026-11-19T00:00Z")).toEqual([["met", 3], ["running", 5]]); // early chase counts
    expect(outcomes(chase, t, "2026-11-23T00:00Z")).toEqual([["met", 3], ["breached", 7]]);
  });

  it("a ticket passes a metric only if ALL its SLAs' finished instances are met", () => {
    const enquiry = def({ id: 4, needs_contractor: 1, stop_on: "marker", stop_value: "enquiry_sent" });
    const reply = def({ id: 5, needs_contractor: 1, start_on: "event_by", start_value: "contractor", repeats: 1 });
    const events = [ev("2026-11-03T14:00Z", "agent", "marker", "enquiry_sent"), ev("2026-11-04T09:00Z", "contractor"), ev("2026-11-10T09:00Z", "agent")];
    const t = ticket("2026-11-02T09:00Z", events, { needs_contractor: 1 });
    expect(ticketPasses([enquiry], t, "2026-12-01")).toBe(true);
    expect(ticketPasses([enquiry, reply], t, "2026-12-01")).toBe(false); // reply took 4 wd
    expect(ticketPasses([enquiry, reply], { ...t, needs_contractor: 0 }, "2026-12-01")).toBeNull(); // doesn't apply
  });
});

describe("scoring — /score", () => {
  it("projects pending metrics as met in the ongoing year, 0 in the year just ended; older years 400", async () => {
    const agent = await login("score-agent@lsq.test", "agent", "estate", null);
    const current = (await (await req("/api/score", agent.cookie)).json()) as any;
    expect(current.ongoing).toBe(true);
    expect(current.projected_fee_ratio).toBeCloseTo(1); // nothing entered, no tickets: all assumed met
    const y = current.service_year;

    const past = (await (await req(`/api/score?year=${y - 1}`, agent.cookie)).json()) as any;
    expect(past).toMatchObject({ service_year: y - 1, ongoing: false, projected_fee_ratio: 0 });
    expect((await req(`/api/score?year=${y - 2}`, agent.cookie)).status).toBe(400);

    // A failed manual entry replaces its assumption.
    await env.DB.prepare(
      "INSERT INTO metric_values (metric_key, service_year, value, result, computed_at) VALUES ('fin.service_charge_accounts', ?, 0, 0, '2026-01-01')"
    ).bind(y).run();
    const after = (await (await req("/api/score", agent.cookie)).json()) as any;
    expect(after.projected_fee_ratio).toBeCloseTo(1 - 0.14);
  });

  it("scores an SLA metric from ticket events, and exposes a ticket's instances", async () => {
    const agent = await login("score-sla@lsq.test", "agent", "estate", null);
    const y = ((await (await req("/api/score", agent.cookie)).json()) as any).service_year;
    const created = `${y}-08-03T09:00:00.000Z`;
    const late = `${y}-09-03T09:00:00.000Z`; // a month later: well past 2 wd
    await env.DB.batch([
      env.DB.prepare("INSERT INTO tickets (id, title, status, classified_by, created_at) VALUES (7001, 'a', 'open', 'agent', ?), (7002, 'b', 'open', 'agent', ?)").bind(created, created),
      env.DB.prepare(
        `INSERT INTO events (subject_type, subject_id, at, actor_role, type, source) VALUES
           ('ticket', 7001, ?, 'resident', 'comment', 'ui'), ('ticket', 7001, ?, 'agent', 'comment', 'ui'),
           ('ticket', 7002, ?, 'resident', 'comment', 'ui'), ('ticket', 7002, ?, 'agent', 'comment', 'ui')`
      ).bind(created, created, created, late),
    ]);
    const score = (await (await req("/api/score", agent.cookie)).json()) as any;
    const m = score.domains.flatMap((d: any) => d.metrics).find((x: any) => x.key === "res.ticket_acknowledgement");
    expect(m).toMatchObject({ value: 0.5, pending: false, basis: "1 of 2 tickets on time" });
    expect(m.result).toBeCloseTo(0.5 / 0.9);

    const slas = (await (await req("/api/tickets/7002/slas", agent.cookie)).json()) as any[];
    expect(slas.map((s) => [s.name, s.outcome])).toEqual([["Acknowledged", "breached"]]);
    const resident = await login("score-res@lsq.test", "resident", "estate", null);
    expect((await req("/api/tickets/7002/slas", resident.cookie)).status).toBe(403);
    expect((await req("/api/score", resident.cookie)).status).toBe(403);
    // Site staff: whole-site tickets, but no scoring, SLA or survey data (D31).
    const staff = await login("score-staff@lsq.test", "site_staff", "estate", null);
    expect((await req("/api/tickets/7002", staff.cookie)).status).toBe(200);
    for (const path of ["/api/score", "/api/slas", "/api/surveys", "/api/tickets/7002/slas", "/api/score/metrics/res.ticket_acknowledgement"])
      expect((await req(path, staff.cookie)).status).toBe(403);

    // The metric detail lists each ticket with its verdict and instances.
    const detail = (await (await req("/api/score/metrics/res.ticket_acknowledgement", agent.cookie)).json()) as any;
    expect(detail.metric).toMatchObject({ key: "res.ticket_acknowledgement", value: 0.5 });
    expect(detail.tickets[0].created_at).toBeTruthy();
    expect(detail.tickets.map((t: any) => [t.id, t.title, t.passes, t.instances[0].outcome])).toEqual([
      [7001, "a", true, "met"],
      [7002, "b", false, "breached"],
    ]);
    expect((await req("/api/score/metrics/nope", agent.cookie)).status).toBe(404);
    expect((await req("/api/score/metrics/res.ticket_acknowledgement", resident.cookie)).status).toBe(403);
  });
});

describe("scoring — year-end snapshots", () => {
  it("board freezes the year just ended to R2; it lists, downloads and is audited", async () => {
    const board = await login("snap-board@lsq.test", "board", "estate", null);
    const y = ((await (await req("/api/score", board.cookie)).json()) as any).service_year;
    expect((await req("/api/score/snapshots", board.cookie, "POST", { year: y })).status).toBe(400); // still running

    const res = await req("/api/score/snapshots", board.cookie, "POST", { year: y - 1 });
    expect(res.status).toBe(201);
    const snap = (await res.json()) as any;
    expect(snap).toMatchObject({ service_year: y - 1, projected_fee_ratio: 0 });

    const list = (await (await req("/api/score/snapshots", board.cookie)).json()) as any[];
    expect(list).toEqual([{ id: snap.id, service_year: y - 1, taken_at: snap.taken_at.replace(/\.\d+Z$/, "Z") }]);
    const file = await req(`/api/score/snapshots/${snap.id}`, board.cookie);
    expect(file.headers.get("content-disposition")).toContain("attachment");
    const body = (await file.json()) as any;
    expect(body.score.service_year).toBe(y - 1);
    expect(body.slas.length).toBe(7);

    const ev = await env.DB.prepare("SELECT to_value FROM events WHERE subject_type = 'score' AND type = 'snapshot'").first<any>();
    expect(ev.to_value).toBe(snap.id);
    expect((await req("/api/score/snapshots/2020/20200101T000000Z", board.cookie)).status).toBe(404);

    const agent = await login("snap-agent@lsq.test", "agent", "estate", null);
    expect((await req("/api/score/snapshots", agent.cookie, "POST", { year: y - 1 })).status).toBe(403);
  });
});

describe("scoring — manual entry, disputes, attestation", () => {
  it("agent enters a manual value (result derived server-side); only the board disputes auto metrics or attests", async () => {
    const agent = await login("mv-enter@lsq.test", "agent", "estate", null);
    const y = ((await (await req("/api/score", agent.cookie)).json()) as any).service_year;
    const res = await req("/api/metric-values", agent.cookie, "POST", { metric_key: "proj.project_timelines", service_year: y, value: 0.76 });
    expect(res.status).toBe(201);
    const row = (await res.json()) as any;
    expect(row.result).toBeCloseTo(0.8); // proportional: 0.76 / 0.95

    const auto = { metric_key: "res.ticket_acknowledgement", service_year: y, value: 1 };
    expect((await req("/api/metric-values", agent.cookie, "POST", auto)).status).toBe(403);
    expect((await req("/api/metric-values", agent.cookie, "POST", { ...auto, metric_key: "proj.project_timelines", service_year: y - 2 })).status).toBe(400);
    expect((await req(`/api/metric-values/${row.id}/attest`, agent.cookie, "PATCH")).status).toBe(403);

    const board = await login("mv-board@lsq.test", "board", "estate", null);
    expect((await req("/api/metric-values", board.cookie, "POST", auto)).status).toBe(201);
    const survey = { metric_key: "res.communication", service_year: y, value: 4.5 };
    expect((await req("/api/metric-values", board.cookie, "POST", survey)).status).toBe(201);
    const attested = (await (await req(`/api/metric-values/${row.id}/attest`, board.cookie, "PATCH")).json()) as any;
    expect(attested.attested_by).toBe(board.id);

    const metrics = ((await (await req("/api/score", agent.cookie)).json()) as any).domains.flatMap((d: any) => d.metrics);
    expect(metrics.find((m: any) => m.key === "proj.project_timelines")).toMatchObject({ pending: false, basis: "entered, attested" });
    expect(metrics.find((m: any) => m.key === "res.ticket_acknowledgement")).toMatchObject({ result: 1, basis: "disputed by the board" });
    expect(metrics.find((m: any) => m.key === "res.communication")).toMatchObject({ result: 1, basis: "disputed by the board" });
  });
});
