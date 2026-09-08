import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../env";
import { body, idParam } from "../../lib/validate";
import { badRequest, forbidden, notFound, conflict } from "../../lib/errors";
import { requireSession } from "../../middleware/session";
import { requirePermission } from "../../middleware/rbac";
import { primaryRole } from "../tickets/service";
import * as svc from "./service";
import type { SurveyResponseRow } from "./service";

const serializeResponse = (r: SurveyResponseRow) => ({
  id: r.id,
  survey_id: r.survey_id,
  answers: JSON.parse(r.answers) as Record<string, number>,
  is_outlier: !!r.is_outlier,
  submitted_on: r.submitted_on,
});

export const engagement = new Hono<AppContext>();
engagement.use("*", requireSession);

// ---- surveys -------------------------------------------------------------
engagement.get("/surveys", requirePermission("survey:read"), async (c) => c.json(await svc.listSurveys(c.env)));

engagement.post("/surveys", requirePermission("survey:manage"), async (c) => {
  const { service_year } = await body(c, z.object({ service_year: z.number().int() }));
  return c.json(await svc.createSurvey(c.env, service_year), 201);
});

engagement.patch("/surveys/:id", requirePermission("survey:manage"), async (c) => {
  const { closed } = await body(c, z.object({ closed: z.boolean() }));
  const s = await svc.setSurveyClosed(c.env, idParam(c), closed);
  if (!s) notFound("no such survey");
  return c.json(s);
});

engagement.get("/surveys/:id/responses", requirePermission("survey:manage"), async (c) => {
  const rows = await svc.surveyResponses(c.env, idParam(c));
  return c.json(rows.map(serializeResponse));
});

// Submit is authenticated + eligibility-checked in the service; the response
// row is anonymous at rest (no account_id / unit_id).
engagement.post("/surveys/:id/responses", requirePermission("survey:respond"), async (c) => {
  const { unit_id, answers } = await body(
    c,
    z.object({
      unit_id: z.number().int().optional(),
      answers: z.record(z.number().int().min(1).max(5)),
    })
  );
  if (Object.keys(answers).length === 0) badRequest("answers required");
  const account = c.get("account");
  const units = svc.eligibleUnits(c.get("grants"));
  const res = await svc.submitResponse(c.env, idParam(c), account.id, units, unit_id, answers);
  if (!res.ok) return ({ 403: forbidden, 404: notFound, 409: conflict }[res.status] ?? badRequest)(res.message);
  return c.json(serializeResponse(res.response), 201);
});

engagement.patch("/surveys/:id/responses/:rid", requirePermission("survey:manage"), async (c) => {
  const { is_outlier } = await body(c, z.object({ is_outlier: z.boolean() }));
  const account = c.get("account");
  const row = await svc.setOutlier(
    c.env,
    idParam(c),
    Number(c.req.param("rid")),
    is_outlier,
    account.id,
    primaryRole(c.get("grants"))
  );
  if (!row) notFound("no such response");
  return c.json(serializeResponse(row!));
});

// ---- site information ----------------------------------------------------
engagement.get("/site-info", requirePermission("config:read"), async (c) =>
  c.json((await svc.getSiteInfo(c.env)) ?? { value: "", updated_at: null })
);

engagement.put("/site-info", requirePermission("config:manage"), async (c) => {
  const { value } = await body(c, z.object({ value: z.string() }));
  const account = c.get("account");
  return c.json(await svc.setSiteInfo(c.env, value, account.id));
});
