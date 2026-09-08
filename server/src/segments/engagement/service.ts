import type { Env } from "../../env";
import { all, one, run } from "../../db/client";
import type { Grant } from "../../db/client";

// ≥N non-outlier responses before a survey metric counts (docs/surveys.md).
export const SCORING_GATE_N = 50;

export interface Survey {
  id: number;
  service_year: number;
  opened_at: string;
  closed_at: string | null;
}
export interface SurveyView extends Survey {
  response_count: number;
  non_outlier_count: number;
  scoring_gate_met: boolean;
}
export interface SurveyResponseRow {
  id: number;
  survey_id: number;
  answers: string; // JSON at rest
  is_outlier: number;
  submitted_on: string;
}
export interface SiteInfo {
  value: string; // markdown
  updated_at: string | null;
}

const iso = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10); // date-only (coarsened)

// ---- surveys -------------------------------------------------------------
async function withCounts(env: Env, s: Survey): Promise<SurveyView> {
  const c = await one<{ total: number; non_outlier: number }>(
    env.DB,
    `SELECT COUNT(*) total, COALESCE(SUM(CASE WHEN is_outlier = 0 THEN 1 ELSE 0 END), 0) non_outlier
       FROM survey_responses WHERE survey_id = ?`,
    s.id
  );
  const non = c?.non_outlier ?? 0;
  return { ...s, response_count: c?.total ?? 0, non_outlier_count: non, scoring_gate_met: non >= SCORING_GATE_N };
}

export async function listSurveys(env: Env): Promise<SurveyView[]> {
  const rows = await all<Survey>(env.DB, "SELECT * FROM surveys ORDER BY service_year DESC, id DESC");
  return Promise.all(rows.map((s) => withCounts(env, s)));
}

export const getSurvey = (env: Env, id: number) => one<Survey>(env.DB, "SELECT * FROM surveys WHERE id = ?", id);

export async function createSurvey(env: Env, serviceYear: number): Promise<SurveyView> {
  const res = await run(env.DB, "INSERT INTO surveys (service_year, opened_at) VALUES (?, ?)", serviceYear, iso());
  return withCounts(env, (await getSurvey(env, res.meta.last_row_id as number))!);
}

export async function setSurveyClosed(env: Env, id: number, closed: boolean): Promise<SurveyView | null> {
  const s = await getSurvey(env, id);
  if (!s) return null;
  await run(env.DB, "UPDATE surveys SET closed_at = ? WHERE id = ?", closed ? iso() : null, id);
  return withCounts(env, (await getSurvey(env, id))!);
}

export const surveyResponses = (env: Env, surveyId: number) =>
  all<SurveyResponseRow>(env.DB, "SELECT * FROM survey_responses WHERE survey_id = ? ORDER BY id", surveyId);

// The unit_ids the caller may vote for: their unit-scoped residence grants.
export const eligibleUnits = (grants: Grant[]) =>
  [...new Set(grants.filter((g) => g.scope_type === "unit" && g.scope_id != null).map((g) => g.scope_id!))];

export type SubmitResult =
  | { ok: true; response: SurveyResponseRow }
  | { ok: false; status: number; message: string };

// One vote per UNIT, anonymous answer row (docs/surveys.md). Ballot + response
// go in one atomic D1 batch: the ballot PK (survey_id, unit_id) makes a repeat
// vote fail the whole batch → nothing written → 409.
export async function submitResponse(
  env: Env,
  surveyId: number,
  accountId: number,
  units: number[],
  bodyUnit: number | undefined,
  answers: Record<string, number>
): Promise<SubmitResult> {
  const survey = await getSurvey(env, surveyId);
  if (!survey) return { ok: false, status: 404, message: "no such survey" };
  if (survey.closed_at) return { ok: false, status: 409, message: "survey is closed" };

  let unit: number;
  if (bodyUnit != null) {
    unit = bodyUnit;
  } else if (units.length === 1) {
    unit = units[0]!;
  } else if (units.length === 0) {
    return { ok: false, status: 403, message: "no eligible unit" };
  } else {
    return { ok: false, status: 400, message: "unit_id required (multiple eligible units)" };
  }
  if (!units.includes(unit)) return { ok: false, status: 403, message: "not eligible to vote for this unit" };

  const now = today();
  try {
    const results = await env.DB.batch([
      env.DB
        .prepare("INSERT INTO survey_ballots (survey_id, unit_id, account_id, voted_on) VALUES (?, ?, ?, ?)")
        .bind(surveyId, unit, accountId, now),
      env.DB
        .prepare("INSERT INTO survey_responses (survey_id, answers, is_outlier, submitted_on) VALUES (?, ?, 0, ?)")
        .bind(surveyId, JSON.stringify(answers), now),
    ]);
    const rid = results[1]!.meta.last_row_id as number;
    return { ok: true, response: (await one<SurveyResponseRow>(env.DB, "SELECT * FROM survey_responses WHERE id = ?", rid))! };
  } catch {
    // Ballot PK violation (unit already voted) rolls back both inserts.
    return { ok: false, status: 409, message: "this unit has already responded" };
  }
}

export async function setOutlier(
  env: Env,
  surveyId: number,
  rid: number,
  isOutlier: boolean,
  actorId: number,
  role: string
): Promise<SurveyResponseRow | null> {
  const row = await one<SurveyResponseRow>(
    env.DB,
    "SELECT * FROM survey_responses WHERE id = ? AND survey_id = ?",
    rid,
    surveyId
  );
  if (!row) return null;
  await run(env.DB, "UPDATE survey_responses SET is_outlier = ? WHERE id = ?", isOutlier ? 1 : 0, rid);
  // Money-affecting + identity-blind → audited on the spine (docs/surveys.md).
  await run(
    env.DB,
    `INSERT INTO events (subject_type, subject_id, at, actor_id, actor_role, type, from_value, to_value, source)
       VALUES ('survey_response', ?, ?, ?, ?, 'status', ?, ?, 'ui')`,
    rid,
    iso(),
    actorId,
    role,
    `is_outlier:${row.is_outlier}`,
    `is_outlier:${isOutlier ? 1 : 0}`
  );
  return one<SurveyResponseRow>(env.DB, "SELECT * FROM survey_responses WHERE id = ?", rid);
}

// ---- site information ----------------------------------------------------
// One markdown blob keyed 'site_info' in the config table; admin-editable,
// readable by anyone signed in. Empty until seeded/set.
export const getSiteInfo = (env: Env) =>
  one<SiteInfo>(env.DB, "SELECT value, updated_at FROM config WHERE key = 'site_info'");

export async function setSiteInfo(env: Env, value: string, updatedBy: number): Promise<SiteInfo> {
  await run(
    env.DB,
    `INSERT INTO config (key, value, updated_at, updated_by) VALUES ('site_info', ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    value,
    iso(),
    updatedBy
  );
  return (await getSiteInfo(env))!;
}
