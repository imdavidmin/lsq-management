import { env } from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";
import { awaitingResidentPass, chasePass, cleanupPass, isReportDay, reminderPass, runScheduled } from "../src/scheduler/cron";
import { seedAccount } from "./helpers";
import { workingDaysBetween } from "../src/lib/workdays";

// Seed a ticket + its latest event at a given time.
async function seedTicket(id: number, status: string, lastEventAt: string, lastType = "comment") {
  await env.DB.prepare(
    "INSERT INTO tickets (id, title, status, classified_by, created_at) VALUES (?, ?, ?, 'agent', ?)"
  ).bind(id, `T${id}`, status, lastEventAt).run();
  await env.DB.prepare(
    `INSERT INTO events (subject_type, subject_id, at, type, source) VALUES ('ticket', ?, ?, ?, 'ui')`
  ).bind(id, lastEventAt, lastType).run();
}

const chaseEvents = (id: number) =>
  env.DB.prepare("SELECT * FROM events WHERE subject_type='ticket' AND subject_id=? AND type='chase'")
    .bind(id)
    .all()
    .then((r) => r.results as any[]);

describe("workdays", () => {
  it("counts working days, skipping weekends and holidays", () => {
    expect(workingDaysBetween("2026-01-05", "2026-01-06")).toBe(1); // Mon→Tue
    expect(workingDaysBetween("2026-01-05", "2026-01-05")).toBe(0); // same day
    expect(workingDaysBetween("2026-01-09", "2026-01-12")).toBe(1); // Fri→Mon (weekend skipped)
    expect(workingDaysBetween("2025-12-31", "2026-01-02")).toBe(1); // Jan 1 holiday skipped
  });
});

describe("scheduler — chase pass", () => {
  it("chases an open ticket stale past the threshold, once", async () => {
    // Last update 2026-02-02 (Mon); run on 2026-02-06 (Fri) = 4 working days.
    await seedTicket(5001, "open", "2026-02-02T09:00:00.000Z");
    const now = new Date("2026-02-06T02:00:00.000Z");

    const first = await chasePass(env, now);
    expect(first.chased).toBe(1);
    expect((await chaseEvents(5001)).length).toBe(1);

    // Re-running finds the latest event is now a chase → not chased again.
    const second = await chasePass(env, now);
    expect(second.chased).toBe(0);
    expect((await chaseEvents(5001)).length).toBe(1);
  });

  it("leaves fresh and closed tickets alone", async () => {
    await seedTicket(5002, "open", "2026-02-05T09:00:00.000Z"); // 1 working day before run
    await seedTicket(5003, "closed", "2026-01-01T09:00:00.000Z"); // stale but closed
    const now = new Date("2026-02-06T02:00:00.000Z");

    await chasePass(env, now);
    expect((await chaseEvents(5002)).length).toBe(0);
    expect((await chaseEvents(5003)).length).toBe(0);
  });
});

describe("scheduler — report day gate", () => {
  it("matches REPORT_DAY_OF_MONTH and clamps to the last day of short months", () => {
    const on = { ...env, REPORT_DAY_OF_MONTH: "20" } as typeof env;
    expect(isReportDay(on, new Date("2026-03-20T02:00:00Z"))).toBe(true);
    expect(isReportDay(on, new Date("2026-03-19T02:00:00Z"))).toBe(false);

    // Day 31 in February clamps to the 28th.
    const late = { ...env, REPORT_DAY_OF_MONTH: "31" } as typeof env;
    expect(isReportDay(late, new Date("2026-02-28T02:00:00Z"))).toBe(true);
  });

  it("runScheduled runs the chase without throwing on a non-report day", async () => {
    await seedTicket(5004, "open", "2026-02-02T09:00:00.000Z");
    const on = { ...env, REPORT_DAY_OF_MONTH: "20" } as typeof env;
    await runScheduled(on, new Date("2026-02-06T02:00:00.000Z"));
    expect((await chaseEvents(5004)).length).toBe(1);
  });
});

describe("scheduler — SLA reminders (D24)", () => {
  it("reminds on the working day an SLA instance is due, without writing events", async () => {
    await seedTicket(5101, "open", "2026-11-06T09:00:00.000Z"); // trace 6
    await env.DB.prepare("UPDATE tickets SET needs_contractor = 1 WHERE id = 5101").run();
    await env.DB.prepare(
      "INSERT INTO events (subject_type, subject_id, at, actor_role, type, to_value, source) VALUES ('ticket', 5101, '2026-11-09T10:00:00Z', 'agent', 'marker', 'enquiry_sent', 'email')"
    ).run();
    const count = () => env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE subject_id = 5101").first("n");
    const before = await count();

    // Due list also includes other seeded SLAs on this ticket; check the chase one by name.
    const dueOn = async (at: string) => (await reminderPass(env, new Date(at))).due;
    expect(await dueOn("2026-11-14T02:00:00Z")).toBe(0); // Saturday: no reminders
    const mon = await dueOn("2026-11-16T02:00:00Z"); // 5 wd: not yet due
    const tue = await dueOn("2026-11-17T02:00:00Z"); // 6 wd: chase due today
    expect(tue).toBe(mon + 1);
    expect(await count()).toBe(before);
  });
});

describe("cleanupPass (D27)", () => {
  it("deletes expired/used login codes and expired sessions, keeps live ones", async () => {
    const id = await seedAccount("cleanup@lsq.test");
    const now = new Date("2026-11-09T02:00:00Z");
    const past = "2026-11-08T00:00:00.000Z";
    const future = "2026-11-10T00:00:00.000Z";
    const otp = (code: string, expires: string, consumed: string | null) =>
      env.DB.prepare(
        "INSERT INTO otp_codes (account_id, code_hash, expires_at, consumed_at, created_at) VALUES (?, ?, ?, ?, ?)"
      ).bind(id, code, expires, consumed, past).run();
    await otp("expired", past, null);
    await otp("used", future, past);
    await otp("live", future, null);
    const session = (token: string, expires: string, hard: string) =>
      env.DB.prepare(
        "INSERT INTO sessions (account_id, token_hash, created_at, last_used_at, expires_at, hard_expires_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(id, token, past, past, expires, hard).run();
    await session("idle", past, future);
    await session("capped", future, past);
    await session("live", future, future);

    expect(await cleanupPass(env, now)).toEqual({ otps: 2, sessions: 2 });
    const left = async (table: string, col: string) =>
      (await env.DB.prepare(`SELECT ${col} AS v FROM ${table} WHERE account_id = ?`).bind(id).all()).results.map((r: any) => r.v);
    expect(await left("otp_codes", "code_hash")).toEqual(["live"]);
    expect(await left("sessions", "token_hash")).toEqual(["live"]);
  });
});


describe("scheduler — awaiting-resident pass (D39)", () => {
  // Ticket 6000+n created by a seeded resident, set awaiting_resident at `since`.
  async function seedAwaiting(id: number, since: string, status = "awaiting_resident") {
    const creator = await seedAccount(`res-${id}@lsq.test`);
    await env.DB.prepare(
      "INSERT INTO tickets (id, title, status, classified_by, created_by, created_at) VALUES (?, ?, ?, 'agent', ?, ?)"
    ).bind(id, `T${id}`, status, creator, since).run();
    await env.DB.prepare(
      `INSERT INTO events (subject_type, subject_id, at, type, from_value, to_value, source)
         VALUES ('ticket', ?, ?, 'status', 'open', 'awaiting_resident', 'ui')`
    ).bind(id, since).run();
  }
  const row = (id: number) => env.DB.prepare("SELECT * FROM tickets WHERE id = ?").bind(id).first<any>();
  const statusEvents = (id: number) =>
    env.DB.prepare("SELECT * FROM events WHERE subject_type='ticket' AND subject_id=? AND actor_role='system'")
      .bind(id).all().then((r) => r.results as any[]);

  it("reminds on day 7 only, closes from day 14, ignores other days and statuses", async () => {
    const mail: any[] = [];
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_i, init) => {
      mail.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 202 });
    });
    const e = { ...env, MAILERSEND_API_KEY: "mlsn.test" } as typeof env;
    await seedAwaiting(6001, "2026-03-01T23:00:00.000Z"); // day 7 on 03-08
    await seedAwaiting(6002, "2026-02-22T09:00:00.000Z"); // day 14
    await seedAwaiting(6003, "2026-03-02T09:00:00.000Z"); // day 6
    await seedAwaiting(6004, "2026-02-22T09:00:00.000Z", "open"); // wrong status

    const now = new Date("2026-03-08T02:00:00.000Z");
    expect(await awaitingResidentPass(e, now)).toEqual({ reminded: 1, closed: 1 });

    expect(mail.map((m) => m.to[0].email).sort()).toEqual(["res-6001@lsq.test", "res-6002@lsq.test"]);
    expect(mail.find((m) => m.to[0].email === "res-6001@lsq.test").text).toContain("closed in 7 days");
    expect(mail.find((m) => m.to[0].email === "res-6002@lsq.test").text).toContain("has been closed");

    expect((await row(6001)).status).toBe("awaiting_resident");
    expect(await statusEvents(6001)).toHaveLength(0); // reminder writes no event
    const closed = await row(6002);
    expect(closed.status).toBe("closed");
    expect(closed.closed_at).toBe(now.toISOString());
    expect(await statusEvents(6002)).toMatchObject([
      { type: "status", from_value: "awaiting_resident", to_value: "closed", source: "system" },
    ]);
    expect((await row(6003)).status).toBe("awaiting_resident");
    expect((await row(6004)).status).toBe("open");
    spy.mockRestore();
  });

  it("counts from the latest re-entry into awaiting_resident", async () => {
    await seedAwaiting(6005, "2026-02-01T09:00:00.000Z"); // first entry, 35 days ago
    await env.DB.prepare(
      `INSERT INTO events (subject_type, subject_id, at, type, from_value, to_value, source) VALUES
         ('ticket', 6005, '2026-02-05T09:00:00.000Z', 'status', 'awaiting_resident', 'open', 'ui'),
         ('ticket', 6005, '2026-03-01T09:00:00.000Z', 'status', 'open', 'awaiting_resident', 'ui')`
    ).run();
    expect(await awaitingResidentPass(env, new Date("2026-03-08T02:00:00.000Z"))).toEqual({ reminded: 1, closed: 0 });
    expect((await row(6005)).status).toBe("awaiting_resident");
  });

  it("runScheduled runs the pass", async () => {
    await seedAwaiting(6006, "2026-02-22T09:00:00.000Z");
    await runScheduled(env, new Date("2026-03-08T02:00:00.000Z"));
    expect((await row(6006)).status).toBe("closed");
  });
});
