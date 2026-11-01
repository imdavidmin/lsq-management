import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../env";
import { body, idParam } from "../../lib/validate";
import { badRequest, forbidden, notFound } from "../../lib/errors";
import { requireSession } from "../../middleware/session";
import { readableGrants, requirePermission } from "../../middleware/rbac";
import { KIND_VALUES, SETTINGS, START_KINDS, STOP_KINDS, type SettingKey, type SlaKind } from "../../../../common/sla";
import { primaryRole } from "../../../../common/roles";
import { metricLabel } from "../../../../common/strings";
import * as svc from "./service";
import type { MetricRow, SlaFields, SlaRow } from "./service";

const serializeMetric = (m: MetricRow) => ({ ...m, active: !!m.active });

const serializeSla = (s: SlaRow) => ({
  ...s,
  needs_contractor: s.needs_contractor == null ? null : !!s.needs_contractor,
  repeats: !!s.repeats,
  active: !!s.active,
});

const kinds = (k: SlaKind[]) => z.enum(k as [SlaKind, ...SlaKind[]]);
const slaFields = z.object({
  name: z.string().trim().min(1),
  metric_key: z.string().min(1),
  category: z.string().min(1).nullable(),
  needs_contractor: z.boolean().nullable(),
  start_on: kinds(START_KINDS),
  start_value: z.string().nullable(),
  stop_on: kinds(STOP_KINDS),
  stop_value: z.string().nullable(),
  budget_days: z.number().int().min(1),
  repeats: z.boolean(),
  active: z.boolean(),
  description: z.string().trim().nullable(),
});
type SlaInput = z.infer<typeof slaFields>;
const slaCreate = slaFields.extend({
  category: slaFields.shape.category.default(null),
  needs_contractor: slaFields.shape.needs_contractor.default(null),
  start_value: slaFields.shape.start_value.default(null),
  stop_value: slaFields.shape.stop_value.default(null),
  repeats: slaFields.shape.repeats.default(false),
  active: slaFields.shape.active.default(true),
  description: slaFields.shape.description.default(null),
});

// Cross-field rules zod can't express per field: values fit their kind (common/sla.ts),
// and SLAs only feed auto metrics (D21). Returns the row shape (0/1) for the service.
async function checkSla(c: { env: AppContext["Bindings"] }, f: SlaInput): Promise<SlaFields> {
  for (const side of ["start", "stop"] as const) {
    const kind = f[`${side}_on`];
    const value = f[`${side}_value`];
    const allowed = KIND_VALUES[kind] as readonly string[];
    if (allowed.length === 0 ? value !== null : !allowed.includes(value ?? ""))
      badRequest(`${side}_value: ${value ?? "null"} is not valid for ${kind}`);
  }
  if (!(await svc.isAutoMetric(c.env, f.metric_key))) badRequest("metric_key: must be an auto metric");
  return {
    ...f,
    needs_contractor: f.needs_contractor == null ? null : Number(f.needs_contractor),
    repeats: Number(f.repeats),
    active: Number(f.active),
  };
}

export const scoring = new Hono<AppContext>();
scoring.use("*", requireSession);

scoring.get("/metrics", requirePermission("metric:read"), async (c) =>
  c.json((await svc.listMetrics(c.env)).map(serializeMetric))
);

// Whole-table metric rules (D6), checked on every bulk edit.
type MetricRules = {
  key: string;
  weight: number;
  mode: string;
  threshold: number | null;
  active: boolean | number;
};

// Problems with the metric table as a whole; empty means it can be saved.
function metricErrors(metrics: MetricRules[]): string[] {
  const errors: string[] = [];
  const active = metrics.filter((m) => m.active);
  const total = active.reduce((sum, m) => sum + m.weight, 0);
  // Weights are stored 0..1 but shown as points out of 100.
  if (Math.abs(total - 1) > 1e-6) errors.push(`Weights must add up to 100 (currently ${+(total * 100).toFixed(2)}).`);
  for (const m of metrics) {
    const name = metricLabel(m.key);
    if (!(m.weight >= 0 && m.weight <= 1)) errors.push(`${name}: weight must be between 0 and 100.`);
    if (m.mode === "proportional" && !(m.threshold != null && m.threshold > 0 && m.threshold <= 1))
      errors.push(`${name}: a proportional threshold must be above 0% and at most 100%.`);
  }
  return errors;
}

// Bulk edit: patches are merged onto the stored table and the result must pass
// the whole-table rules (weights sum to 100, …) before anything is written.
scoring.patch("/metrics", requirePermission("metric:manage"), async (c) => {
  const patches = await body(
    c,
    z.array(
      z.object({
        key: z.string(),
        weight: z.number().optional(),
        mode: z.enum(["binary", "proportional"]).optional(),
        threshold: z.number().nullable().optional(),
        active: z.boolean().optional(),
        description: z.string().trim().nullable().optional(),
      })
    ).min(1)
  );
  const table = new Map((await svc.listMetrics(c.env)).map((m) => [m.key, m]));
  const changed = patches.map(({ key, active, description, ...rest }) => {
    const m = table.get(key);
    if (!m) notFound(`no such metric: ${key}`);
    const row = {
      ...m!,
      ...rest,
      ...(active !== undefined && { active: Number(active) }),
      // Blank clears the description.
      ...(description !== undefined && { description: description || null }),
    };
    table.set(key, row);
    return row;
  });
  const errors = metricErrors([...table.values()]);
  if (errors.length) badRequest(errors.join("\n")); // one problem per line, listed by the web editor
  return c.json((await svc.updateMetrics(c.env, changed)).map(serializeMetric));
});

scoring.get("/metric-values", requirePermission("metric:read"), async (c) => {
  const year = c.req.query("year");
  if (year !== undefined && !/^\d{4}$/.test(year)) badRequest("year: must be a 4-digit year");
  return c.json(await svc.listMetricValues(c.env, year === undefined ? undefined : Number(year), c.req.query("metric")));
});

scoring.post("/metric-values", requirePermission("metric:enter"), async (c) => {
  const v = await body(
    c,
    z.object({ metric_key: z.string(), service_year: z.number().int(), value: z.number().min(0), notes: z.string().trim().min(1).optional() })
  );
  const m = await svc.getMetric(c.env, v.metric_key);
  if (!m) notFound(`no such metric: ${v.metric_key}`);
  // Overriding a computed metric is a board dispute, not data entry.
  if (m!.source !== "manual" && !(await readableGrants(c, "metric:dispute")).length)
    forbidden("only the board can dispute a computed metric");
  await scoredYear(c, String(v.service_year), new Date());
  return c.json(await svc.createMetricValue(c.env, m!, v, c.get("account").id), 201);
});

scoring.patch("/metric-values/:id/attest", requirePermission("metric:attest"), async (c) => {
  const actor = { id: c.get("account").id, role: primaryRole(c.get("grants")) };
  const row = await svc.attestMetricValue(c.env, idParam(c), actor);
  if (!row) notFound("no such metric value");
  return c.json(row);
});

// ---- score (D13/D21) ------------------------------------------------------
// Only the ongoing and the just-ended service year are scored; older years
// live in their year-end snapshot.
async function scoredYear(c: { env: AppContext["Bindings"] }, raw: string | undefined, now: Date) {
  const current = await svc.currentServiceYear(c.env, now);
  if (raw === undefined) return current;
  const year = Number(raw);
  if (year !== current && year !== current - 1) badRequest(`year: only ${current - 1} or ${current} can be scored`);
  return year;
}

scoring.get("/score", requirePermission("score:read"), async (c) => {
  const now = new Date();
  const year = await scoredYear(c, c.req.query("year"), now);
  return c.json((await svc.evaluateYear(c.env, year, now)).score);
});

scoring.get("/score/metrics/:key", requirePermission("score:read"), async (c) => {
  const now = new Date();
  const year = await scoredYear(c, c.req.query("year"), now);
  const detail = await svc.metricDetail(c.env, year, c.req.param("key"), now);
  if (!detail) notFound("no such active metric");
  return c.json(detail);
});

// Year-end snapshot: only a service year that has ended can be frozen.
scoring.post("/score/snapshots", requirePermission("score:snapshot"), async (c) => {
  const { year } = await body(c, z.object({ year: z.number().int() }));
  const now = new Date();
  const ended = (await svc.currentServiceYear(c.env, now)) - 1;
  if (year !== ended) badRequest(`year: only ${ended}, the year just ended, can be snapshotted`);
  const actor = { id: c.get("account").id, role: primaryRole(c.get("grants")) };
  return c.json(await svc.takeSnapshot(c.env, year, now, actor), 201);
});

scoring.get("/score/snapshots", requirePermission("score:read"), async (c) => c.json(await svc.listSnapshots(c.env)));

scoring.get("/score/snapshots/:year/:stamp", requirePermission("score:read"), async (c) => {
  const obj = await svc.getSnapshot(c.env, c.req.param("year"), c.req.param("stamp"));
  if (!obj) notFound("no such snapshot");
  return new Response(obj!.body, {
    headers: {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="lsq-score-${c.req.param("year")}-${c.req.param("stamp")}.json"`,
    },
  });
});

scoring.get(
  "/tickets/:id/slas",
  requirePermission("sla:read", (c) => ({ type: "ticket", id: idParam(c) })),
  async (c) => {
    const rows = await svc.ticketSlas(c.env, idParam(c), new Date());
    if (!rows) notFound("no such ticket");
    return c.json(rows);
  }
);

// ---- SLAs (D21) -----------------------------------------------------------
scoring.get("/slas", requirePermission("sla:read"), async (c) => c.json((await svc.listSlas(c.env)).map(serializeSla)));

scoring.post("/slas", requirePermission("sla:manage"), async (c) => {
  const f = await checkSla(c, await body(c, slaCreate));
  const actor = { id: c.get("account").id, role: primaryRole(c.get("grants")) };
  return c.json(serializeSla(await svc.createSla(c.env, f, actor)), 201);
});

// Partial edit: merge onto the stored row, then validate the whole as on create.
scoring.patch("/slas/:id", requirePermission("sla:manage"), async (c) => {
  const patch = await body(c, slaFields.partial());
  const before = await svc.getSla(c.env, idParam(c));
  if (!before) notFound("no such SLA");
  const { id: _, ...current } = serializeSla(before!);
  const f = await checkSla(c, { ...(current as SlaInput), ...patch });
  const actor = { id: c.get("account").id, role: primaryRole(c.get("grants")) };
  return c.json(serializeSla(await svc.updateSla(c.env, before!, f, actor)));
});

// ---- scoring settings -------------------------------------------------------
scoring.get("/config", requirePermission("config:read"), async (c) => c.json(await svc.listSettings(c.env)));

scoring.put("/config/:key", requirePermission("config:manage"), async (c) => {
  const key = c.req.param("key");
  if (!(key in SETTINGS)) notFound("no such setting");
  const { value } = await body(c, z.object({ value: z.string() }));
  if (!SETTINGS[key as SettingKey].test(value)) badRequest(`value: invalid for ${key}`);
  return c.json(await svc.setSetting(c.env, key as SettingKey, value, c.get("account").id));
});
