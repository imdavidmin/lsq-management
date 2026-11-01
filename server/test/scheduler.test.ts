import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { chasePass, isReportDay, reminderPass, runScheduled } from "../src/scheduler/cron";
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
