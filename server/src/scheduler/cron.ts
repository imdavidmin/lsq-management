import type { Env } from "../env";
import { all, run } from "../db/client";
import { workingDaysBetween } from "../lib/workdays";
import { sendMail } from "../segments/auth/mailer";

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
      to: env.BOARD_EMAIL,
      subject: `LSQ: ${chased.length} ticket(s) chased`,
      text: chased.map((t) => `#${t.id} ${t.title} (last update ${t.last_at})`).join("\n"),
    });
  }
  return { chased: chased.length };
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

// Daily entry (UJ-11/12): chase always; monthly report on the configured day.
export async function runScheduled(env: Env, now: Date): Promise<void> {
  await chasePass(env, now);
  if (isReportDay(env, now)) {
    // TODO(phase 4): const report = await monthlyReport(env, prevMonth(now));
    //                await sendMail(env, { to: env.BOARD_EMAIL, ...report });
    // Blocked on the scoring report generator (segments/scoring/report.ts).
    console.log("report day — monthly report generator pending Phase 4");
  }
}
