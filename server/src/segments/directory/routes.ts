import { Hono } from "hono";
import { z } from "zod";
import type { AppContext } from "../../env";
import type { Account } from "../../db/client";
import { body, idParam } from "../../lib/validate";
import { badRequest, conflict, notFound } from "../../lib/errors";
import { requireSession } from "../../middleware/session";
import { requirePermission } from "../../middleware/rbac";
import { logAccess } from "../../lib/audit";
import { primaryRole } from "../../../../common/roles";
import { isPersonalDomain } from "../../../../common/senders";
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
  const a = await body(
    c,
    z
      .object({
        email: z.string().email(),
        name: z.string().min(1),
        role_key: z.string().min(1),
        building_id: z.number().int().nullish(),
        unit: z.string().trim().min(1).nullish(),
        org_id: z.number().int().nullish(),
      })
      .refine((a) => !a.unit || a.building_id != null, { message: "building_id required with unit" })
      .refine((a) => a.role_key !== "resident" || !!a.unit, { message: "a resident needs a unit" })
  );
  if (await svc.emailInUse(c.env, a.email)) conflict("email already exists");
  const res = await svc.inviteAccount(c.env, { ...a, loginUrl: new URL(c.req.url).origin });
  if ("error" in res) return badRequest(res.error);
  return c.json(serializeAccount(res), 201);
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

// Erasure = move-out (D30): anonymises the account, keeps the ticket record.
directory.delete("/accounts/:id", requirePermission("account:manage"), async (c) => {
  const id = idParam(c);
  if (id === c.var.account.id) badRequest("you can't delete your own account");
  if (!(await svc.getAccount(c.env, id))) notFound("no such account");
  await svc.eraseAccount(c.env, id, c.var.account.id);
  return c.body(null, 204);
});

// Extra inbound addresses (D29). Read via GET /accounts/:id?reveal=email.
directory.post("/accounts/:id/emails", requirePermission("account:manage"), async (c) => {
  const { email } = await body(c, z.object({ email: z.string().email() }));
  if (!(await svc.getAccount(c.env, idParam(c)))) notFound("no such account");
  if (await svc.emailInUse(c.env, email)) conflict("email already in use");
  await svc.addAccountEmail(c.env, idParam(c), email, c.var.account.id);
  return c.body(null, 204);
});

directory.delete("/accounts/:id/emails/:email", requirePermission("account:manage"), async (c) => {
  if (!(await svc.removeAccountEmail(c.env, idParam(c), c.req.param("email")))) notFound("no such address");
  return c.body(null, 204);
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

// Orgs added here are contractors; the agent is seeded. A personal domain would
// sweep residents' mail into the org, so it's refused.
const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .transform((d) => d.replace(/^@/, ""))
  .pipe(z.string().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, "a domain like acme.co.uk"))
  .refine((d) => !isPersonalDomain(d), "personal mail domains can't belong to an organization");

directory.post("/organizations", requirePermission("org:manage"), async (c) => {
  const { name, kind, domain } = await body(
    c,
    orgSchema.extend({ kind: orgSchema.shape.kind.default("contractor"), domain: domainSchema.optional() })
  );
  const org = await svc.createOrganization(c.env, name, kind, domain);
  if (org === "domain_taken") conflict("that domain already belongs to an organization");
  return c.json(org, 201);
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

// Link an unknown email sender to a person instead of an org (D29).
directory.post("/senders/:id/account", requirePermission("sender:manage"), async (c) => {
  const { account_id } = await body(c, z.object({ account_id: z.number().int() }));
  const res = await svc.linkSenderToAccount(c.env, idParam(c), account_id, c.var.account.id);
  if (res === "no_sender") notFound("no such sender");
  if (res === "no_account") notFound("no such account");
  if (res === "domain") badRequest("only an email sender can be linked to a person");
  if (res === "in_use") conflict("email already belongs to an account");
  return c.body(null, 204);
});

directory.delete("/senders/:id", requirePermission("sender:manage"), async (c) => {
  if (!(await svc.deleteSender(c.env, idParam(c)))) notFound("no such sender");
  return c.body(null, 204);
});

// ---- mail aliases (D26) --------------------------------------------------
// Board-provisioned <local_part>@MAIL_DOMAIN forwards. mail:manage is board/admin
// only, so the agent can't re-point board@ (D26).
const localPart = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, "lowercase letters, digits, . _ - only")
  .refine((l) => !/^\d+$/.test(l), "all-digit addresses look like tickets");
const aliasActor = (c: any) => ({ id: c.get("account").id, role: primaryRole(c.get("grants")) });

directory.get("/mail-aliases", requirePermission("mail:read"), async (c) => c.json(await svc.listMailAliases(c.env)));

directory.put("/mail-aliases/:local_part", requirePermission("mail:manage"), async (c) => {
  const name = localPart.safeParse(c.req.param("local_part"));
  if (!name.success) badRequest(name.error.issues[0]?.message);
  const own = c.env.MAIL_DOMAIN;
  const { forward_to } = await body(
    c,
    z.object({
      forward_to: z
        .array(z.string().email().transform((e) => e.toLowerCase()))
        .min(1)
        .max(10)
        .refine((list) => list.every((e) => !e.endsWith(`@${own}`) && !e.endsWith(`.${own}`)), {
          message: "can't forward to our own domain (mail loop)",
        }),
    })
  );
  return c.json(await svc.putMailAlias(c.env, aliasActor(c), name.data!, forward_to));
});

// The urgent auto-reply sent by inbox triage (D32); same audience as the aliases.
directory.get("/urgent-reply", requirePermission("mail:read"), async (c) => c.json(await svc.getUrgentReply(c.env)));

directory.put("/urgent-reply", requirePermission("mail:manage"), async (c) => {
  const { value } = await body(c, z.object({ value: z.string().trim().min(1).max(5000) }));
  return c.json(await svc.setUrgentReply(c.env, aliasActor(c), value));
});

directory.delete("/mail-aliases/:local_part", requirePermission("mail:manage"), async (c) => {
  if (!(await svc.deleteMailAlias(c.env, aliasActor(c), c.req.param("local_part")))) notFound("no such alias");
  return c.body(null, 204);
});
