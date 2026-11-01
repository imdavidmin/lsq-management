import type { Env } from "../../env";
import { all, one, run } from "../../db/client";
import { SETTINGS, type SettingKey } from "../../../../common/sla";
import { applies, instances, ticketPasses, type Instance, type SlaEvent, type SlaTicket } from "../../lib/sla";

export interface MetricRow {
  key: string;
  domain: string;
  weight: number;
  mode: string;
  threshold: number | null;
  source: string;
  active: number;
  description: string | null;
}

// 0/1 and NULL-able columns as stored; routes serialize to booleans.
export interface SlaRow {
  id: number;
  name: string;
  metric_key: string;
  category: string | null;
  needs_contractor: number | null;
  start_on: string;
  start_value: string | null;
  stop_on: string;
  stop_value: string | null;
  budget_days: number;
  repeats: number;
  active: number;
  description: string | null;
}
export type SlaFields = Omit<SlaRow, "id">;

export interface ConfigEntry {
  key: string;
  value: string;
  updated_at: string | null;
}

const iso = () => new Date().toISOString();

export const listMetrics = (env: Env) => all<MetricRow>(env.DB, "SELECT * FROM metrics ORDER BY key");

// Writes the given rows in one batch, so the table never holds a half-applied edit.
export async function updateMetrics(env: Env, rows: MetricRow[]) {
  const update = env.DB.prepare(
    "UPDATE metrics SET weight = ?, mode = ?, threshold = ?, active = ?, description = ? WHERE key = ?"
  );
  await env.DB.batch(rows.map((m) => update.bind(m.weight, m.mode, m.threshold, m.active, m.description, m.key)));
  return listMetrics(env);
}

export interface MetricValueRow {
  id: number;
  metric_key: string;
  service_year: number;
  value: number;
  result: number;
  entered_by: number | null;
  attested_by: number | null;
  computed_at: string;
  notes: string | null;
}

// Every stored value, newest first; superseded rows stay visible as history.
export const listMetricValues = (env: Env, year?: number, metric?: string) =>
  all<MetricValueRow>(
    env.DB,
    `SELECT * FROM metric_values
       WHERE (?1 IS NULL OR service_year = ?1) AND (?2 IS NULL OR metric_key = ?2)
       ORDER BY computed_at DESC, id DESC`,
    year ?? null,
    metric ?? null
  );

export const getMetric = (env: Env, key: string) => one<MetricRow>(env.DB, "SELECT * FROM metrics WHERE key = ?", key);

// A superseding insert: the newest row per (metric, year) wins (UJ-15/UJ-08).
export async function createMetricValue(
  env: Env,
  m: MetricRow,
  v: { service_year: number; value: number; notes?: string },
  accountId: number
) {
  const res = await run(
    env.DB,
    `INSERT INTO metric_values (metric_key, service_year, value, result, entered_by, computed_at, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    m.key,
    v.service_year,
    v.value,
    resultOf(m, v.value),
    accountId,
    iso(),
    v.notes ?? null
  );
  return (await one<MetricValueRow>(env.DB, "SELECT * FROM metric_values WHERE id = ?", res.meta.last_row_id))!;
}

export async function attestMetricValue(env: Env, id: number, actor: { id: number; role: string | null }) {
  const row = await one<MetricValueRow>(env.DB, "SELECT * FROM metric_values WHERE id = ?", id);
  if (!row) return null;
  await env.DB.batch([
    env.DB.prepare("UPDATE metric_values SET attested_by = ? WHERE id = ?").bind(actor.id, id),
    env.DB.prepare(
      `INSERT INTO events (subject_type, subject_id, at, actor_id, actor_role, type, source)
         VALUES ('metric_value', ?, ?, ?, ?, 'attest', 'ui')`
    ).bind(id, iso(), actor.id, actor.role),
  ]);
  return { ...row, attested_by: actor.id };
}

export const isAutoMetric = async (env: Env, key: string) =>
  !!(await one(env.DB, "SELECT 1 FROM metrics WHERE key = ? AND source = 'auto'", key));

export const listSlas = (env: Env) => all<SlaRow>(env.DB, "SELECT * FROM slas ORDER BY metric_key, id");
export const getSla = (env: Env, id: number) => one<SlaRow>(env.DB, "SELECT * FROM slas WHERE id = ?", id);

// Every create/update is audited on the spine as a `config` event (D7/D21).
async function auditSla(env: Env, id: number, actor: { id: number; role: string | null }, from: SlaRow | null, to: SlaRow) {
  await run(
    env.DB,
    `INSERT INTO events (subject_type, subject_id, at, actor_id, actor_role, type, from_value, to_value, source)
       VALUES ('sla', ?, ?, ?, ?, 'config', ?, ?, 'ui')`,
    id,
    iso(),
    actor.id,
    actor.role,
    from && JSON.stringify(from),
    JSON.stringify(to)
  );
}

const COLUMNS = [
  "name", "metric_key", "category", "needs_contractor", "start_on", "start_value",
  "stop_on", "stop_value", "budget_days", "repeats", "active", "description",
] as const;

export async function createSla(env: Env, f: SlaFields, actor: { id: number; role: string | null }) {
  const res = await run(
    env.DB,
    `INSERT INTO slas (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})`,
    ...COLUMNS.map((c) => f[c])
  );
  const row = (await getSla(env, res.meta.last_row_id as number))!;
  await auditSla(env, row.id, actor, null, row);
  return row;
}

export async function updateSla(env: Env, before: SlaRow, f: SlaFields, actor: { id: number; role: string | null }) {
  await run(
    env.DB,
    `UPDATE slas SET ${COLUMNS.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`,
    ...COLUMNS.map((c) => f[c]),
    before.id
  );
  const row = (await getSla(env, before.id))!;
  await auditSla(env, row.id, actor, before, row);
  return row;
}

// ---- scoring settings ------------------------------------------------------
const KEYS = Object.keys(SETTINGS) as SettingKey[];

export const listSettings = (env: Env) =>
  all<ConfigEntry>(
    env.DB,
    `SELECT key, value, updated_at FROM config WHERE key IN (${KEYS.map(() => "?").join(",")}) ORDER BY key`,
    ...KEYS
  );

export async function setSetting(env: Env, key: SettingKey, value: string, updatedBy: number) {
  await run(
    env.DB,
    `INSERT INTO config (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    key,
    value,
    iso(),
    updatedBy
  );
  return (await one<ConfigEntry>(env.DB, "SELECT key, value, updated_at FROM config WHERE key = ?", key))!;
}

// ---- score (D13/D21) --------------------------------------------------------
const SURVEY_MIN_RESPONSES = 50; // docs/surveys.md gate

// Service years are labelled by the calendar year they start in.
async function yearStart(env: Env) {
  return (await one<{ value: string }>(env.DB, "SELECT value FROM config WHERE key = 'service_year_start'"))?.value ?? "08-01";
}
export async function currentServiceYear(env: Env, now: Date) {
  const mmdd = await yearStart(env);
  const y = now.getUTCFullYear();
  return now.toISOString().slice(5, 10) >= mmdd ? y : y - 1;
}

interface ScoredTicket {
  id: number;
  title: string;
  category: string | null;
  needs_contractor: number;
  is_duplicate: number;
  created_at: string;
  events: (SlaEvent & { id: number })[];
}

export interface MetricScore {
  key: string;
  source: string;
  weight: number;
  value: number | null;
  result: number;
  pending: boolean;
  basis: string;
}

// Site-inspection defects in scope, and whether staff raised one (its first event is the creator's).
const inspectionDefects = (ts: ScoredTicket[]) => ts.filter((t) => t.category === "site_defect" && !t.is_duplicate);
const raisedByStaff = (t: ScoredTicket) => ["agent", "admin"].includes(t.events[0]?.actor_role ?? "");

// A ticket's instances of every applicable SLA, labelled for display.
const namedInstances = (slas: SlaRow[], t: SlaTicket, now: string) =>
  slas
    .filter((s) => applies(s, t))
    .flatMap((s) => instances(s, t, now).map((i) => ({ ...i, name: s.name, metric_key: s.metric_key, budget_days: s.budget_days })));

const resultOf = (m: MetricRow, value: number) =>
  m.mode === "binary" ? (value >= (m.threshold ?? 1) ? 1 : 0) : Math.min(1, value / (m.threshold ?? 1));

// Every input for one service year, evaluated as of `now`. Pending metrics are
// assumed met in the ongoing year and score 0 once it has ended.
export async function evaluateYear(env: Env, year: number, now: Date) {
  const mmdd = await yearStart(env);
  const from = `${year}-${mmdd}T00:00:00.000Z`;
  const to = `${year + 1}-${mmdd}T00:00:00.000Z`;
  const ongoing = now.toISOString() < to;
  const nowIso = now.toISOString();

  const [metrics, slas, tickets, events, stored, surveys] = await Promise.all([
    all<MetricRow>(env.DB, "SELECT * FROM metrics WHERE active = 1 ORDER BY key"),
    all<SlaRow>(env.DB, "SELECT * FROM slas WHERE active = 1 ORDER BY id"),
    all<Omit<ScoredTicket, "events">>(
      env.DB,
      "SELECT id, title, category, needs_contractor, is_duplicate, created_at FROM tickets WHERE created_at >= ? AND created_at < ? ORDER BY id",
      from,
      to
    ),
    all<SlaEvent & { id: number; subject_id: number }>(
      env.DB,
      `SELECT e.id, e.subject_id, e.at, e.actor_role, e.type, e.to_value FROM events e
         JOIN tickets t ON e.subject_type = 'ticket' AND e.subject_id = t.id
        WHERE t.created_at >= ? AND t.created_at < ? ORDER BY e.at, e.id`,
      from,
      to
    ),
    // Latest row per metric wins (superseding inserts).
    all<MetricValueRow>(
      env.DB,
      `SELECT * FROM metric_values v WHERE service_year = ? AND id = (
         SELECT id FROM metric_values WHERE metric_key = v.metric_key AND service_year = v.service_year
          ORDER BY computed_at DESC, id DESC LIMIT 1)`,
      year
    ),
    all<{ answers: string }>(
      env.DB,
      "SELECT r.answers FROM survey_responses r JOIN surveys s ON s.id = r.survey_id WHERE s.service_year = ? AND r.is_outlier = 0",
      year
    ),
  ]);

  const byTicket = new Map<number, ScoredTicket>(tickets.map((t) => [t.id, { ...t, events: [] }]));
  for (const e of events) byTicket.get(e.subject_id)?.events.push(e);
  const scored = [...byTicket.values()];
  const storedBy = new Map(stored.map((v) => [v.metric_key, v]));
  const answers = surveys.map((r) => JSON.parse(r.answers) as Record<string, number>);

  const pending = (m: MetricRow, basis: string): MetricScore => ({
    key: m.key, source: m.source, weight: m.weight, value: null, result: ongoing ? 1 : 0, pending: true,
    basis: ongoing ? `${basis} — assumed met` : basis,
  });
  const done = (m: MetricRow, value: number, basis: string, result = resultOf(m, value)): MetricScore => ({
    key: m.key, source: m.source, weight: m.weight, value, result, pending: false, basis,
  });

  const metricScores = metrics.map((m): MetricScore => {
    if (m.source === "manual") {
      const v = storedBy.get(m.key);
      return v ? done(m, v.value, v.attested_by ? "entered, attested" : "entered", v.result) : pending(m, "not entered yet");
    }
    // Board disputes override a computed value (latest stored row wins).
    const disputed = storedBy.get(m.key);
    if (disputed) return done(m, disputed.value, "disputed by the board", disputed.result);
    if (m.source === "survey") {
      const field = m.key.slice(m.key.indexOf(".") + 1);
      const ratings = answers.map((a) => a[field]).filter((n): n is number => typeof n === "number");
      if (ratings.length < SURVEY_MIN_RESPONSES) return pending(m, `${ratings.length} of ${SURVEY_MIN_RESPONSES} responses`);
      const mean = ratings.reduce((a, b) => a + b, 0) / ratings.length;
      return done(m, +mean.toFixed(2), `mean of ${ratings.length} responses`);
    }
    const mine = slas.filter((s) => s.metric_key === m.key);
    if (mine.length) {
      const verdicts = scored.map((t) => ticketPasses(mine, t, nowIso)).filter((v): v is boolean => v !== null);
      if (!verdicts.length) return pending(m, "no tickets scored yet");
      const met = verdicts.filter(Boolean).length;
      return done(m, +(met / verdicts.length).toFixed(4), `${met} of ${verdicts.length} tickets on time`);
    }
    if (m.key === "site.site_inspection") {
      const defects = inspectionDefects(scored);
      if (!defects.length) return pending(m, "no defect tickets yet");
      const staff = defects.filter(raisedByStaff).length;
      return done(m, +(staff / defects.length).toFixed(4), `${staff} of ${defects.length} defects raised by staff`);
    }
    return pending(m, "no rule computes this metric");
  });

  const domainOf = new Map(metrics.map((m) => [m.key, m.domain]));
  const domains = [...new Set(domainOf.values())].map((domain) => {
    const ms = metricScores.filter((m) => domainOf.get(m.key) === domain);
    const weight = ms.reduce((a, m) => a + m.weight, 0);
    const sum = ms.reduce((a, m) => a + m.weight * m.result, 0);
    return { domain, weight, result: weight ? sum / weight : 0, metrics: ms };
  });

  const ticketResults = scored.map((t) => ({
    id: t.id,
    instances: slas.filter((s) => applies(s, t)).flatMap((s) => instances(s, t, nowIso)),
  }));

  return {
    from,
    score: {
      service_year: year,
      ongoing,
      projected_fee_ratio: metricScores.reduce((a, m) => a + m.weight * m.result, 0),
      domains,
    },
    tickets: ticketResults.filter((t) => t.instances.length) as { id: number; instances: Instance[] }[],
    slas,
    metrics,
    scored,
  };
}

// One metric's score with the tickets behind it: `passes` is null while a ticket isn't counted yet.
export async function metricDetail(env: Env, year: number, key: string, now: Date) {
  const { score, slas, scored } = await evaluateYear(env, year, now);
  const metric = score.domains.flatMap((d) => d.metrics).find((m) => m.key === key);
  if (!metric) return null;
  const nowIso = now.toISOString();
  const mine = slas.filter((s) => s.metric_key === key);
  const tickets = mine.length
    ? scored
        .filter((t) => mine.some((s) => applies(s, t)))
        .map((t) => ({ id: t.id, title: t.title, created_at: t.created_at, passes: ticketPasses(mine, t, nowIso), instances: namedInstances(mine, t, nowIso) }))
    : key === "site.site_inspection"
      ? inspectionDefects(scored).map((t) => ({ id: t.id, title: t.title, created_at: t.created_at, passes: raisedByStaff(t), instances: [] }))
      : [];
  return { service_year: score.service_year, ongoing: score.ongoing, metric, tickets };
}

// One ticket's SLA instances, for the ticket page.
export async function ticketSlas(env: Env, id: number, now: Date) {
  const t = await one<{ category: string | null; needs_contractor: number; created_at: string }>(
    env.DB,
    "SELECT category, needs_contractor, created_at FROM tickets WHERE id = ?",
    id
  );
  if (!t) return null;
  const events = await all<SlaEvent>(
    env.DB,
    "SELECT at, actor_role, type, to_value FROM events WHERE subject_type = 'ticket' AND subject_id = ? ORDER BY at, id",
    id
  );
  const slas = await all<SlaRow>(env.DB, "SELECT * FROM slas WHERE active = 1 ORDER BY id");
  return namedInstances(slas, { ...t, events }, now.toISOString());
}

// ---- year-end snapshots (D21) ----------------------------------------------
// Snapshot ids are `<year>/<compact UTC stamp>`, e.g. 2026/20270802T090000Z.
const stamp = (iso: string) => iso.replace(/[-:]|\.\d+/g, "");
const fromStamp = (s: string) => s.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, "$1-$2-$3T$4:$5:$6Z");

export async function takeSnapshot(env: Env, year: number, now: Date, actor: { id: number; role: string | null }) {
  const { from, score, tickets, slas, metrics } = await evaluateYear(env, year, now);
  const slaEdits = await all(
    env.DB,
    "SELECT * FROM events WHERE subject_type = 'sla' AND type = 'config' AND at >= ? ORDER BY at, id",
    from
  );
  const taken_at = now.toISOString();
  const id = `${year}/${stamp(taken_at)}`;
  await env.SNAPSHOTS.put(
    `snapshots/${id}.json`,
    JSON.stringify({ taken_at, taken_by: actor.id, score, metrics, slas, sla_edits: slaEdits, tickets }),
    { httpMetadata: { contentType: "application/json" } }
  );
  await run(
    env.DB,
    `INSERT INTO events (subject_type, subject_id, at, actor_id, actor_role, type, to_value, source)
       VALUES ('score', ?, ?, ?, ?, 'snapshot', ?, 'ui')`,
    year,
    taken_at,
    actor.id,
    actor.role,
    id
  );
  return { id, service_year: year, taken_at, projected_fee_ratio: score.projected_fee_ratio };
}

export async function listSnapshots(env: Env) {
  const { objects } = await env.SNAPSHOTS.list({ prefix: "snapshots/" });
  return objects
    .flatMap((o) => {
      const m = o.key.match(/^snapshots\/(\d{4})\/(\w+)\.json$/);
      return m ? [{ id: `${m[1]}/${m[2]}`, service_year: Number(m[1]), taken_at: fromStamp(m[2]!) }] : [];
    })
    .sort((a, b) => b.taken_at.localeCompare(a.taken_at));
}

export const getSnapshot = (env: Env, year: string, s: string) => env.SNAPSHOTS.get(`snapshots/${year}/${s}.json`);
