import type { Env } from "../env";
import { all, run } from "../db/client";
import { emailRoles } from "../lib/emailRoles";
import { applies, instances, type SlaDef, type SlaEvent, type SlaTicket } from "../lib/sla";
import { isWorkingDay, workingDaysBetween } from "../lib/workdays";
import { layout, render, sendMail } from "../../../common/mail";
import { emailCreator, type Ticket } from "../segments/tickets/service";

// A digest of tickets, each linked to the app (D35).
const ticketList = (env: Env, heading: string, rows: { id: number; title: string; note: string }[]) =>
  layout(
    env,
    render("ticket-digest", {
      heading,
      rows: rows
        .map((r) => render("ticket-digest-row", { url: `${env.APP_URL}/tickets/${r.id}`, ticket_id: r.id, title: r.title, note: r.note }))
        .join(""),
    })
  );

// Chase a still-open ticket after this many working days with no update.
const CHASE_AFTER_WORKDAYS = 3;

interface StaleRow {
  id: number;
  title: string;
  last_at: string;
  last_type: string;
}

// UJ-12: append a `chase` event for each open ticket gone quiet, and notify.
// Skips tickets whose most recent event is itself a chase, so a ticket is
// chased once per stall — not every night.
export async function chasePass(env: Env, now: Date): Promise<{ chased: number }> {
  const rows = await all<StaleRow>(
    env.DB,
    `SELECT t.id, t.title, MAX(e.at) AS last_at,
        (SELECT type FROM events WHERE subject_type = 'ticket' AND subject_id = t.id
           ORDER BY at DESC, id DESC LIMIT 1) AS last_type
       FROM tickets t
       JOIN events e ON e.subject_type = 'ticket' AND e.subject_id = t.id
      WHERE t.status IN ('open', 'pending_3rd_party')
      GROUP BY t.id`
  );

  const nowIso = now.toISOString();
  const chased: StaleRow[] = [];
  for (const r of rows) {
    if (r.last_type === "chase") continue; // already chasing this stall
    if (workingDaysBetween(r.last_at, nowIso) < CHASE_AFTER_WORKDAYS) continue;
    await run(
      env.DB,
      `INSERT INTO events (subject_type, subject_id, at, actor_role, type, body, source)
         VALUES ('ticket', ?, ?, 'system', 'chase', ?, 'system')`,
      r.id,
      nowIso,
      `No update in ${CHASE_AFTER_WORKDAYS}+ working days.`
    );
    chased.push(r);
  }

  // ponytail: one digest to the board (who track delivery), not per-responsible-
  // party mail — no single agent-email var yet. Route per-party once directory
  // lookup of the responsible account is wired.
  if (chased.length) {
    await sendMail(env, {
      to: [env.BOARD_EMAIL],
      subject: `LSQ: ${chased.length} ticket(s) chased`,
      text: chased.map((t) => `#${t.id} ${t.title} (last update ${t.last_at})`).join("\n"),
      html: ticketList(
        env,
        `No update in ${CHASE_AFTER_WORKDAYS}+ working days:`,
        chased.map((t) => ({ id: t.id, title: t.title, note: `last update ${t.last_at.slice(0, 10)}` }))
      ),
    });
  }
  return { chased: chased.length };
}

// D24: on working days, remind the agents of SLA instances due today (still
// running, at their budget). A plain email — nothing is written to `events`.
export async function reminderPass(env: Env, now: Date): Promise<{ due: number }> {
  if (!isWorkingDay(now)) return { due: 0 };
  const nowIso = now.toISOString();
  const [slas, tickets, events, agents, resolveRole] = await Promise.all([
    all<SlaDef & { name: string }>(env.DB, "SELECT * FROM slas WHERE active = 1 ORDER BY id"),
    all<Omit<SlaTicket, "events"> & { id: number; title: string }>(
      env.DB,
      "SELECT id, title, category, needs_contractor, created_at FROM tickets WHERE status IN ('open', 'pending_3rd_party') ORDER BY id"
    ),
    all<SlaEvent & { subject_id: number; actor_id: number | null; actor_email: string | null }>(
      env.DB,
      `SELECT e.subject_id, e.at, e.actor_id, e.actor_email, e.actor_role, e.type, e.to_value FROM events e
         JOIN tickets t ON e.subject_type = 'ticket' AND e.subject_id = t.id
        WHERE t.status IN ('open', 'pending_3rd_party') ORDER BY e.at, e.id`
    ),
    all<{ email: string }>(
      env.DB,
      "SELECT DISTINCT a.email FROM accounts a JOIN grants g ON g.account_id = a.id WHERE g.role_key = 'agent' AND a.active = 1"
    ),
    emailRoles(env.DB),
  ]);

  const due: { id: number; title: string; note: string }[] = [];
  for (const t of tickets) {
    const ticket = { ...t, events: events.filter((e) => e.subject_id === t.id).map(resolveRole) };
    for (const s of slas.filter((s) => applies(s, ticket))) {
      if (instances(s, ticket, nowIso).some((i) => i.outcome === "running" && i.days === s.budget_days)) {
        due.push({ id: t.id, title: t.title, note: s.name });
      }
    }
  }

  if (due.length) {
    for (const a of agents) {
      await sendMail(env, {
        to: [a.email],
        subject: `LSQ: ${due.length} SLA(s) due today`,
        text: due.map((d) => `#${d.id} ${d.title}: ${d.note}`).join("\n"),
        html: ticketList(env, "SLAs due today:", due),
      });
    }
  }
  return { due: due.length };
}

const REMIND_AFTER_DAYS = 7;
const CLOSE_AFTER_DAYS = 14;
const REMINDER_TEXT = `We're still waiting for your reply on this ticket. If we don't hear back it will be closed in ${CLOSE_AFTER_DAYS - REMIND_AFTER_DAYS} days.`;
const CLOSED_TEXT = `This ticket has been closed after ${CLOSE_AFTER_DAYS} days without a reply. Please start a new ticket if you still need help.`;
const CLOSE_NOTE = `Closed after ${CLOSE_AFTER_DAYS} days awaiting the resident.`;

const utcDay = (iso: string) => Date.parse(iso.slice(0, 10)) / 86_400_000;

// D39: email the creator after 7 calendar days in awaiting_resident (no event);
// close the ticket after 14 and email again. Runs every day, not just working days.
export async function awaitingResidentPass(env: Env, now: Date): Promise<{ reminded: number; closed: number }> {
  const nowIso = now.toISOString();
  const rows = await all<Ticket & { since: string }>(
    env.DB,
    `SELECT t.*, MAX(e.at) AS since FROM tickets t
       JOIN events e ON e.subject_type = 'ticket' AND e.subject_id = t.id
                    AND e.type = 'status' AND e.to_value = 'awaiting_resident'
      WHERE t.status = 'awaiting_resident' GROUP BY t.id`
  );
  let reminded = 0;
  let closed = 0;
  for (const t of rows) {
    const days = utcDay(nowIso) - utcDay(t.since);
    if (days >= CLOSE_AFTER_DAYS) {
      // Guarded: skip if the resident replied since the read (D39).
      const [, update] = await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO events (subject_type, subject_id, at, actor_role, type, from_value, to_value, body, source)
           SELECT 'ticket', id, ?, 'system', 'status', 'awaiting_resident', 'closed', ?, 'system'
             FROM tickets WHERE id = ? AND status = 'awaiting_resident'`
        ).bind(nowIso, CLOSE_NOTE, t.id),
        env.DB.prepare("UPDATE tickets SET status = 'closed', closed_at = ? WHERE id = ? AND status = 'awaiting_resident'").bind(nowIso, t.id),
      ]);
      if (!update!.meta.changes) continue;
      await emailCreator(env, t, null, CLOSED_TEXT);
      closed++;
    } else if (days === REMIND_AFTER_DAYS) {
      await emailCreator(env, t, null, REMINDER_TEXT);
      reminded++;
    }
  }
  return { reminded, closed };
}

// D27: purge login codes that are expired or used, and sessions past either
// expiry. Neither is audit data; both are dead once expired.
export async function cleanupPass(env: Env, now: Date): Promise<{ otps: number; sessions: number }> {
  const nowIso = now.toISOString();
  const otps = await run(env.DB, "DELETE FROM otp_codes WHERE expires_at < ? OR consumed_at IS NOT NULL", nowIso);
  const sessions = await run(env.DB, "DELETE FROM sessions WHERE expires_at < ? OR hard_expires_at < ?", nowIso, nowIso);
  return { otps: otps.meta.changes ?? 0, sessions: sessions.meta.changes ?? 0 };
}

// The day-of-month the monthly report fires, clamped to the month's last day
// (REPORT_DAY_OF_MONTH may exceed a short month — see architecture.md).
function reportDay(env: Env, now: Date): number {
  const want = Number(env.REPORT_DAY_OF_MONTH) || 1;
  const lastDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  return Math.min(want, lastDay);
}

export function isReportDay(env: Env, now: Date): boolean {
  return now.getUTCDate() === reportDay(env, now);
}

// Daily entry (UJ-11/12, D24, D27, D39): chase, SLA reminders, awaiting-resident and auth cleanup always;
// monthly report on the configured day.
export async function runScheduled(env: Env, now: Date): Promise<void> {
  await reminderPass(env, now);
  await chasePass(env, now);
  await awaitingResidentPass(env, now);
  await cleanupPass(env, now);
  if (isReportDay(env, now)) {
    // TODO(phase 4): const report = await monthlyReport(env, prevMonth(now));
    //                await sendMail(env, { to: env.BOARD_EMAIL, ...report });
    // Blocked on the scoring report generator (segments/scoring/report.ts).
    console.log("report day — monthly report generator pending Phase 4");
  }
}
