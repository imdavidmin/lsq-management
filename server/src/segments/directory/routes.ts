import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../env";
import type { Account } from "../../db/client";
import { body, idParam } from "../../lib/validate";
import { badRequest, conflict, notFound } from "../../lib/errors";
import { requireSession } from "../../middleware/session";
import { requirePermission } from "../../middleware/rbac";
import { logAccess } from "../../lib/audit";
import * as svc from "./service";

const serializeAccount = (a: Account) => ({ ...a, active: !!a.active });
const scopeTypes = ["estate", "building", "unit", "organization", "ticket"] as const;
const revealFields = ["email", "units"] as const;

export const directory = new Hono<AppContext>();
directory.use("*", requireSession);

// ---- accounts ------------------------------------------------------------
// Minimised list (no email, no exact unit) + one 'list account' audit row.
directory.get("/accounts", requirePermission("account:read"), async (c) => {
  const summaries = await svc.listAccountSummaries(c.env);
  await logAccess(c.env, c.var.account.id, "list", "account");
  return c.json(summaries);
});

directory.post("/accounts", requirePermission("account:manage"), async (c) => {
  const { email, name, unit_id } = await body(
    c,
    z.object({ email: z.string().email(), name: z.string().min(1), unit_id: z.number().int().nullish() })
  );
  if (await svc.accountByEmail(c.env, email)) conflict("email already exists");
  const loginUrl = new URL(c.req.url).origin;
  return c.json(serializeAccount(await svc.inviteAccount(c.env, { email, name, unit_id, loginUrl })), 201);
});

// PII reveal: ?reveal=email,units unmasks those fields and audits which were
// exposed. Without it, returns the minimised record (name + non-unit grants).
directory.get("/accounts/:id", requirePermission("account:read"), async (c) => {
  const raw = (c.req.query("reveal") ?? "").split(",").map((f) => f.trim()).filter(Boolean);
  const bad = raw.filter((f) => !revealFields.includes(f as (typeof revealFields)[number]));
  if (bad.length) badRequest(`unknown reveal field(s): ${bad.join(", ")}`);
  const reveal = { email: raw.includes("email"), units: raw.includes("units") };

  const detail = await svc.accountDetail(c.env, idParam(c), reveal);
  if (!detail) notFound("no such account");
  await logAccess(c.env, c.var.account.id, "view", "account", idParam(c), { fields: raw });
  return c.json(detail);
});

directory.patch("/accounts/:id", requirePermission("account:manage"), async (c) => {
  const p = await body(c, z.object({ name: z.string().min(1), active: z.boolean() }).partial());
  if (!(await svc.getAccount(c.env, idParam(c)))) notFound("no such account");
  return c.json(serializeAccount(await svc.patchAccount(c.env, idParam(c), p)));
});

directory.get("/accounts/:id/grants", requirePermission("grant:read"), async (c) =>
  c.json(await svc.accountGrants(c.env, idParam(c)))
);

// ---- grants --------------------------------------------------------------
const grantSchema = z
  .object({
    account_id: z.number().int(),
    role_key: z.string().min(1),
    scope_type: z.enum(scopeTypes),
    scope_id: z.number().int().nullish(),
  })
  .refine((g) => g.scope_type === "estate" || g.scope_id != null, {
    message: "scope_id required unless scope_type is estate",
  });

directory.post("/grants", requirePermission("grant:manage"), async (c) => {
  const g = await body(c, grantSchema);
  const res = await svc.createGrant(c.env, { ...g, scope_id: g.scope_id ?? null });
  if ("error" in res) badRequest(res.error);
  return c.json(res, 201);
});

directory.delete("/grants/:id", requirePermission("grant:manage"), async (c) => {
  if (!(await svc.deleteGrant(c.env, idParam(c)))) notFound("no such grant");
  return c.body(null, 204);
});

// ---- roles ---------------------------------------------------------------
directory.get("/roles", requirePermission("role:read"), async (c) => c.json(await svc.listRoles(c.env)));

directory.post("/roles", requirePermission("role:manage"), async (c) => {
  const { key, name } = await body(c, z.object({ key: z.string().min(1), name: z.string().min(1) }));
  if (await svc.roleExists(c.env, key)) conflict("role already exists");
  return c.json(await svc.createRole(c.env, key, name), 201);
});

directory.put("/roles/:key/permissions", requirePermission("role:manage"), async (c) => {
  const { permissions } = await body(c, z.object({ permissions: z.array(z.string()) }));
  const key = c.req.param("key");
  if (!(await svc.roleExists(c.env, key))) notFound("no such role");
  return c.json(await svc.setRolePermissions(c.env, key, permissions));
});

// ---- places --------------------------------------------------------------
directory.get("/buildings", requirePermission("dir:read"), async (c) => c.json(await svc.listBuildings(c.env)));

directory.post("/buildings", requirePermission("dir:manage"), async (c) => {
  const { name } = await body(c, z.object({ name: z.string().min(1) }));
  return c.json(await svc.createBuilding(c.env, name), 201);
});

directory.get("/buildings/:id/units", requirePermission("dir:read"), async (c) =>
  c.json(await svc.buildingUnits(c.env, idParam(c)))
);

directory.post("/units", requirePermission("dir:manage"), async (c) => {
  const { building_id, label } = await body(
    c,
    z.object({ building_id: z.number().int(), label: z.string().min(1) })
  );
  return c.json(await svc.createUnit(c.env, building_id, label), 201);
});

// ---- organizations -------------------------------------------------------
const orgSchema = z.object({ name: z.string().min(1), kind: z.enum(["agent", "contractor"]) });

directory.get("/organizations", requirePermission("org:read"), async (c) =>
  c.json(await svc.listOrganizations(c.env))
);

directory.post("/organizations", requirePermission("org:manage"), async (c) => {
  const { name, kind } = await body(c, orgSchema);
  return c.json(await svc.createOrganization(c.env, name, kind), 201);
});

directory.patch("/organizations/:id", requirePermission("org:manage"), async (c) => {
  const { name, kind } = await body(c, orgSchema);
  const org = await svc.patchOrganization(c.env, idParam(c), name, kind);
  if (!org) notFound("no such organization");
  return c.json(org);
});

// ---- senders -------------------------------------------------------------
directory.get("/senders", requirePermission("sender:read"), async (c) => {
  const status = c.req.query("status");
  if (status && !["new", "ignored", "linked"].includes(status)) badRequest("bad status");
  return c.json(await svc.listSenders(c.env, status));
});

directory.post("/senders", requirePermission("sender:manage"), async (c) => {
  const s = await body(
    c,
    z.object({
      match_type: z.enum(["email", "domain"]),
      match_value: z.string().min(1),
      org_id: z.number().int(),
    })
  );
  return c.json(await svc.createSender(c.env, s.match_type, s.match_value, s.org_id), 201);
});

directory.patch("/senders/:id", requirePermission("sender:manage"), async (c) => {
  const p = await body(
    c,
    z
      .object({ org_id: z.number().int().nullable(), status: z.enum(["new", "ignored", "linked"]) })
      .partial()
  );
  const s = await svc.patchSender(c.env, idParam(c), p);
  if (!s) notFound("no such sender");
  return c.json(s);
});

directory.delete("/senders/:id", requirePermission("sender:manage"), async (c) => {
  if (!(await svc.deleteSender(c.env, idParam(c)))) notFound("no such sender");
  return c.body(null, 204);
});
