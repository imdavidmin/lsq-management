import type { Env } from "../../env";
import { all, one, run, grantsForAccount } from "../../db/client";
import type { Account, Grant } from "../../db/client";
import { sendMail } from "../auth/mailer";
import { fail } from "../../lib/errors";
import { primaryRole } from "../../../../common/roles";

export interface Role {
  key: string;
  name: string;
}
export interface Building {
  id: number;
  name: string;
}
export interface Unit {
  id: number;
  building_id: number;
  label: string;
}
export interface Organization {
  id: number;
  name: string;
  kind: "agent" | "contractor";
}
export interface Sender {
  id: number;
  match_type: "email" | "domain";
  match_value: string;
  org_id: number | null;
  status: "new" | "ignored" | "linked";
  hit_count: number;
  first_seen: string;
  last_seen: string;
}

const iso = () => new Date().toISOString();

// ---- accounts ------------------------------------------------------------
export const listAccounts = (env: Env) =>
  all<Account>(env.DB, "SELECT id, email, name, active FROM accounts WHERE erased_at IS NULL ORDER BY name");

// Minimised directory listing (GDPR data-minimisation, docs/gdpr.md). No email,
// no exact unit — only the coarse building(s) a person is associated with, plus
// their role keys. Email and unit are reveal-gated on the detail endpoint.
export interface AccountSummary {
  id: number;
  name: string;
  active: boolean;
  roles: string[];
  buildings: string[];
}
export async function listAccountSummaries(env: Env): Promise<AccountSummary[]> {
  const accounts = await all<Account>(env.DB, "SELECT id, name, active FROM accounts WHERE erased_at IS NULL ORDER BY name");
  const grants = await all<Grant>(
    env.DB,
    "SELECT account_id, role_key, scope_type, scope_id FROM grants"
  );
  const buildings = await listBuildings(env);
  const units = await all<Unit>(env.DB, "SELECT id, building_id FROM units");
  const buildingName = (id: number | null) => buildings.find((b) => b.id === id)?.name;
  const unitBuilding = (id: number | null) => buildingName(units.find((u) => u.id === id)?.building_id ?? null);

  return accounts.map((a) => {
    const gs = grants.filter((g) => g.account_id === a.id);
    const bnames = gs
      .map((g) =>
        g.scope_type === "building" ? buildingName(g.scope_id) : g.scope_type === "unit" ? unitBuilding(g.scope_id) : undefined
      )
      .filter((n): n is string => !!n);
    return {
      id: a.id,
      name: a.name,
      active: !!a.active,
      roles: [...new Set(gs.map((g) => g.role_key))].sort(),
      buildings: [...new Set(bnames)].sort(),
    };
  });
}

// Reveal-gated account detail. Email is returned only when `email` is revealed;
// unit-scoped grants (the household-identifying ones) only when `units` is
// revealed. Non-unit grants are always returned — they're needed to manage
// access and are not household-identifying. Caller must audit each reveal.
export interface AccountDetail {
  id: number;
  name: string;
  active: boolean;
  email?: string;
  emails?: string[]; // extra inbound addresses (D29), revealed with email
  grants: Grant[];
  units?: string[]; // resolved unit labels, present only when units revealed
}
export async function accountDetail(
  env: Env,
  id: number,
  reveal: { email: boolean; units: boolean }
): Promise<AccountDetail | null> {
  const a = await getAccount(env, id);
  if (!a) return null;
  const grants = await accountGrants(env, id);
  const unitGrants = grants.filter((g) => g.scope_type === "unit");
  let units: string[] | undefined;
  if (reveal.units && unitGrants.length) {
    const ids = unitGrants.map((g) => g.scope_id).filter((x): x is number => x != null);
    const rows = await all<Unit>(
      env.DB,
      `SELECT id, building_id, label FROM units WHERE id IN (${ids.map(() => "?").join(",")})`,
      ...ids
    );
    units = ids.map((uid) => rows.find((r) => r.id === uid)?.label ?? `unit #${uid}`);
  }
  return {
    id: a.id,
    name: a.name,
    active: !!a.active,
    ...(reveal.email ? { email: a.email, emails: await accountEmails(env, id) } : {}),
    grants: reveal.units ? grants : grants.filter((g) => g.scope_type !== "unit"),
    ...(reveal.units ? { units: units ?? [] } : {}),
  };
}

export const getAccount = (env: Env, id: number) =>
  one<Account>(env.DB, "SELECT id, email, name, active FROM accounts WHERE id = ? AND erased_at IS NULL", id);

// An address is unique across primary (accounts) and extra (account_emails) ones (D29).
export const emailInUse = async (env: Env, email: string) =>
  !!(await one(
    env.DB,
    "SELECT 1 FROM accounts WHERE email = ?1 UNION SELECT 1 FROM account_emails WHERE email = ?1",
    email.toLowerCase()
  ));

const accountEmails = async (env: Env, accountId: number) =>
  (await all<{ email: string }>(env.DB, "SELECT email FROM account_emails WHERE account_id = ? ORDER BY email", accountId)).map(
    (r) => r.email
  );

// Extra inbound addresses (D29): attribution only, never a login identity.
export async function addAccountEmail(env: Env, accountId: number, email: string, addedBy: number): Promise<void> {
  await run(
    env.DB,
    "INSERT INTO account_emails (email, account_id, added_at, added_by) VALUES (?, ?, ?, ?)",
    email.toLowerCase(),
    accountId,
    iso(),
    addedBy
  );
}

export async function removeAccountEmail(env: Env, accountId: number, email: string): Promise<boolean> {
  const res = await run(
    env.DB,
    "DELETE FROM account_emails WHERE account_id = ? AND email = ?",
    accountId,
    email.toLowerCase()
  );
  return (res.meta.changes ?? 0) > 0;
}

export async function createAccount(env: Env, email: string, name: string): Promise<Account> {
  const res = await run(
    env.DB,
    "INSERT INTO accounts (email, name, active) VALUES (?, ?, 1)",
    email.toLowerCase(),
    name
  );
  return (await getAccount(env, res.meta.last_row_id as number))!;
}

// Typed unit labels are matched case-insensitively within the building, else created.
async function findOrCreateUnit(env: Env, buildingId: number, label: string): Promise<number> {
  const found = await one<{ id: number }>(
    env.DB,
    "SELECT id FROM units WHERE building_id = ? AND lower(label) = lower(?)",
    buildingId,
    label
  );
  return found?.id ?? (await createUnit(env, buildingId, label)).id;
}

// Onboard a person: create the account and its grants, then email an invitation.
// A unit makes them a resident of it; any other role is held estate-wide, or on
// an organization when one is given. Activation is the passwordless OTP flow
// (docs/authentication.md), so the invite just points them at sign-in.
export async function inviteAccount(
  env: Env,
  a: {
    email: string;
    name: string;
    role_key: string;
    building_id?: number | null;
    unit?: string | null;
    org_id?: number | null;
    loginUrl: string;
  }
): Promise<Account | { error: string }> {
  if (!(await roleExists(env, a.role_key))) return { error: "no such role" };
  if (a.building_id != null && !(await one(env.DB, "SELECT 1 FROM buildings WHERE id = ?", a.building_id)))
    return { error: "no such building" };
  if (a.org_id != null && !(await one(env.DB, "SELECT 1 FROM organizations WHERE id = ?", a.org_id)))
    return { error: "no such organization" };

  const account = await createAccount(env, a.email, a.name);
  const grant = (role: string, scopeType: Grant["scope_type"], scopeId: number | null) =>
    run(
      env.DB,
      "INSERT INTO grants (account_id, role_key, scope_type, scope_id) VALUES (?, ?, ?, ?)",
      account.id,
      role,
      scopeType,
      scopeId
    );
  if (a.unit) await grant("resident", "unit", await findOrCreateUnit(env, a.building_id!, a.unit));
  if (a.role_key !== "resident") {
    await grant(a.role_key, a.org_id != null ? "organization" : "estate", a.org_id ?? null);
  }

  await sendMail(env, {
    to: account.email,
    subject: "You've been invited to Lansbury Square",
    text:
      `Hi ${a.name},\n\n` +
      `An account has been created for you on the Lansbury Square portal.\n` +
      `To activate it, sign in with this email address at:\n\n${a.loginUrl}\n\n` +
      `You'll be sent a one-time login code — no password needed.\n`,
  });
  return account;
}

// Erase a person (D30): the row becomes an anonymous tombstone named for their
// household or role, so ticket history keeps its references but loses identity.
export async function eraseAccount(env: Env, id: number, actorId: number): Promise<void> {
  const account = (await getAccount(env, id))!;
  const grants = await accountGrants(env, id);
  const label = await erasureLabel(env, grants);
  const addresses = [account.email, ...(await accountEmails(env, id))];
  const inList = addresses.map(() => "?").join(",");

  // Raw originals carry their address and signature; delete those first (R2 isn't in the batch).
  const originals = await all<{ id: number; r2_key: string }>(
    env.DB,
    `SELECT at.id, at.r2_key FROM attachments at JOIN events e ON e.id = at.event_id
      WHERE at.kind = 'original' AND (e.actor_id = ? OR e.actor_email IN (${inList}))`,
    id,
    ...addresses
  );
  if (originals.length) await env.MAIL.delete(originals.map((o) => o.r2_key));

  const stmt = (sql: string, ...params: unknown[]) => env.DB.prepare(sql).bind(...params);
  await env.DB.batch([
    ...originals.map((o) => stmt("DELETE FROM attachments WHERE id = ?", o.id)),
    stmt(`UPDATE events SET actor_id = ?, actor_email = NULL WHERE actor_email IN (${inList})`, id, ...addresses),
    stmt("UPDATE accounts SET name = ?, email = NULL, active = 0, erased_at = ? WHERE id = ?", label, iso(), id),
    stmt("DELETE FROM grants WHERE account_id = ?", id),
    stmt("DELETE FROM sessions WHERE account_id = ?", id),
    stmt("DELETE FROM otp_codes WHERE account_id = ?", id),
    stmt("DELETE FROM account_emails WHERE account_id = ?", id),
    stmt(
      `INSERT INTO events (subject_type, subject_id, at, actor_id, actor_role, type, to_value, source)
       VALUES ('account', ?, ?, ?, ?, 'erase', ?, 'ui')`,
      id,
      iso(),
      actorId,
      primaryRole(await accountGrants(env, actorId)),
      label
    ),
  ]);
}

// "Resident of Flat 12, Banbury Point" for households; else the role name
// (plus organization for org-scoped grants), e.g. "Contractor, Acme Ltd".
async function erasureLabel(env: Env, grants: Grant[]): Promise<string> {
  const unitIds = grants.filter((g) => g.scope_type === "unit").map((g) => g.scope_id);
  if (unitIds.length) {
    const units = await all<{ label: string; building: string }>(
      env.DB,
      `SELECT u.label, b.name AS building FROM units u JOIN buildings b ON b.id = u.building_id
        WHERE u.id IN (${unitIds.map(() => "?").join(",")}) ORDER BY u.id`,
      ...unitIds
    );
    return `Resident of ${units.map((u) => `${u.label}, ${u.building}`).join("; ")}`;
  }
  const roleKey = primaryRole(grants.length ? grants : [{ role_key: "resident" }]);
  const role = await one<{ name: string }>(env.DB, "SELECT name FROM roles WHERE key = ?", roleKey);
  const orgId = grants.find((g) => g.role_key === roleKey && g.scope_type === "organization")?.scope_id;
  const org = orgId != null ? await one<{ name: string }>(env.DB, "SELECT name FROM organizations WHERE id = ?", orgId) : null;
  return [role?.name ?? "Former user", org?.name].filter(Boolean).join(", ");
}

export async function patchAccount(
  env: Env,
  id: number,
  p: { name?: string; active?: boolean }
): Promise<Account> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (p.name !== undefined) (sets.push("name = ?"), params.push(p.name));
  if (p.active !== undefined) (sets.push("active = ?"), params.push(p.active ? 1 : 0));
  if (sets.length) {
    params.push(id);
    await run(env.DB, `UPDATE accounts SET ${sets.join(", ")} WHERE id = ?`, ...params);
  }
  return (await getAccount(env, id))!;
}

// ---- grants --------------------------------------------------------------
export const accountGrants = (env: Env, accountId: number) => grantsForAccount(env.DB, accountId);

export async function createGrant(
  env: Env,
  g: { account_id: number; role_key: string; scope_type: Grant["scope_type"]; scope_id: number | null }
): Promise<Grant | { error: string }> {
  if (!(await getAccount(env, g.account_id))) return { error: "no such account" };
  if (!(await one(env.DB, "SELECT 1 FROM roles WHERE key = ?", g.role_key)))
    return { error: "no such role" };
  const res = await run(
    env.DB,
    "INSERT INTO grants (account_id, role_key, scope_type, scope_id) VALUES (?, ?, ?, ?)",
    g.account_id,
    g.role_key,
    g.scope_type,
    g.scope_type === "estate" ? null : g.scope_id
  );
  return (await one<Grant>(
    env.DB,
    "SELECT id, account_id, role_key, scope_type, scope_id FROM grants WHERE id = ?",
    res.meta.last_row_id as number
  ))!;
}

export async function deleteGrant(env: Env, id: number): Promise<boolean> {
  const res = await run(env.DB, "DELETE FROM grants WHERE id = ?", id);
  return (res.meta.changes ?? 0) > 0;
}

// ---- roles ---------------------------------------------------------------
export async function listRoles(env: Env): Promise<(Role & { permissions: string[] })[]> {
  const roles = await all<Role>(env.DB, "SELECT key, name FROM roles ORDER BY key");
  const perms = await all<{ role_key: string; permission: string }>(
    env.DB,
    "SELECT role_key, permission FROM role_permissions"
  );
  return roles.map((r) => ({
    ...r,
    permissions: perms.filter((p) => p.role_key === r.key).map((p) => p.permission).sort(),
  }));
}

export const roleExists = (env: Env, key: string) =>
  one(env.DB, "SELECT 1 FROM roles WHERE key = ?", key);

export async function createRole(env: Env, key: string, name: string): Promise<Role & { permissions: string[] }> {
  await run(env.DB, "INSERT INTO roles (key, name) VALUES (?, ?)", key, name);
  return { key, name, permissions: [] };
}

export async function setRolePermissions(
  env: Env,
  key: string,
  permissions: string[]
): Promise<Role & { permissions: string[] }> {
  await run(env.DB, "DELETE FROM role_permissions WHERE role_key = ?", key);
  for (const p of [...new Set(permissions)]) {
    await run(env.DB, "INSERT INTO role_permissions (role_key, permission) VALUES (?, ?)", key, p);
  }
  const role = await one<Role>(env.DB, "SELECT key, name FROM roles WHERE key = ?", key);
  return { ...role!, permissions: [...new Set(permissions)].sort() };
}

// ---- places --------------------------------------------------------------
export const listBuildings = (env: Env) =>
  all<Building>(env.DB, "SELECT id, name FROM buildings ORDER BY name");

export async function createBuilding(env: Env, name: string): Promise<Building> {
  const res = await run(env.DB, "INSERT INTO buildings (name) VALUES (?)", name);
  return { id: res.meta.last_row_id as number, name };
}

export const buildingUnits = (env: Env, buildingId: number) =>
  all<Unit>(env.DB, "SELECT id, building_id, label FROM units WHERE building_id = ? ORDER BY label", buildingId);

export async function createUnit(env: Env, buildingId: number, label: string): Promise<Unit> {
  const res = await run(
    env.DB,
    "INSERT INTO units (building_id, label) VALUES (?, ?)",
    buildingId,
    label
  );
  return { id: res.meta.last_row_id as number, building_id: buildingId, label };
}

// ---- organizations -------------------------------------------------------
export const listOrganizations = (env: Env) =>
  all<Organization>(env.DB, "SELECT id, name, kind FROM organizations ORDER BY name");

export async function createOrganization(
  env: Env,
  name: string,
  kind: Organization["kind"]
): Promise<Organization> {
  const res = await run(env.DB, "INSERT INTO organizations (name, kind) VALUES (?, ?)", name, kind);
  return { id: res.meta.last_row_id as number, name, kind };
}

export async function patchOrganization(
  env: Env,
  id: number,
  name: string,
  kind: Organization["kind"]
): Promise<Organization | null> {
  const res = await run(
    env.DB,
    "UPDATE organizations SET name = ?, kind = ? WHERE id = ?",
    name,
    kind,
    id
  );
  if ((res.meta.changes ?? 0) === 0) return null;
  return { id, name, kind };
}

// ---- senders -------------------------------------------------------------
export function listSenders(env: Env, status?: string): Promise<Sender[]> {
  return status
    ? all<Sender>(env.DB, "SELECT * FROM senders WHERE status = ? ORDER BY hit_count DESC", status)
    : all<Sender>(env.DB, "SELECT * FROM senders ORDER BY hit_count DESC");
}

// A manually added rule points at an org, so it lands 'linked'.
export async function createSender(
  env: Env,
  match_type: Sender["match_type"],
  match_value: string,
  org_id: number
): Promise<Sender> {
  const now = iso();
  const res = await run(
    env.DB,
    `INSERT INTO senders (match_type, match_value, org_id, status, hit_count, first_seen, last_seen)
       VALUES (?, ?, ?, 'linked', 0, ?, ?)`,
    match_type,
    match_value.toLowerCase(),
    org_id,
    now,
    now
  );
  return (await one<Sender>(env.DB, "SELECT * FROM senders WHERE id = ?", res.meta.last_row_id as number))!;
}

export async function patchSender(
  env: Env,
  id: number,
  p: { org_id?: number | null; status?: Sender["status"] }
): Promise<Sender | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (p.org_id !== undefined) (sets.push("org_id = ?"), params.push(p.org_id));
  if (p.status !== undefined) (sets.push("status = ?"), params.push(p.status));
  if (sets.length) {
    params.push(id);
    const res = await run(env.DB, `UPDATE senders SET ${sets.join(", ")} WHERE id = ?`, ...params);
    if ((res.meta.changes ?? 0) === 0) return null;
  }
  return one<Sender>(env.DB, "SELECT * FROM senders WHERE id = ?", id);
}

// An unknown email sender is a person's extra address: move it onto the account
// (D29). It's then no longer unknown, and account matches win in attribution.
export async function linkSenderToAccount(
  env: Env,
  senderId: number,
  accountId: number,
  actorId: number
): Promise<"ok" | "no_sender" | "no_account" | "domain" | "in_use"> {
  const s = await one<Sender>(env.DB, "SELECT * FROM senders WHERE id = ?", senderId);
  if (!s) return "no_sender";
  if (s.match_type !== "email") return "domain";
  if (!(await getAccount(env, accountId))) return "no_account";
  if (await emailInUse(env, s.match_value)) return "in_use";
  await env.DB.batch([
    env.DB.prepare("INSERT INTO account_emails (email, account_id, added_at, added_by) VALUES (?, ?, ?, ?)").bind(
      s.match_value,
      accountId,
      iso(),
      actorId
    ),
    env.DB.prepare("DELETE FROM senders WHERE id = ?").bind(senderId),
  ]);
  return "ok";
}

export async function deleteSender(env: Env, id: number): Promise<boolean> {
  const res = await run(env.DB, "DELETE FROM senders WHERE id = ?", id);
  return (res.meta.changes ?? 0) > 0;
}

// ---- mail aliases (D26) --------------------------------------------------
// One JSON doc in the config table (key 'mail_aliases', { local_part: [destinations] });
// the email Worker reads it and forwards a copy to each destination. Audited on events.
type Aliases = Record<string, string[]>;
export interface MailAlias {
  local_part: string;
  address: string;
  forward_to: { email: string; verified: boolean | null }[]; // null = unknown (no CF token)
}
type Actor = { id: number; role: string | null };

async function readAliases(env: Env): Promise<Aliases> {
  const row = await one<{ value: string }>(env.DB, "SELECT value FROM config WHERE key = 'mail_aliases'");
  return row ? (JSON.parse(row.value) as Aliases) : {};
}

const writeAliases = (env: Env, aliases: Aliases, updatedBy: number) =>
  run(
    env.DB,
    `INSERT INTO config (key, value, updated_at, updated_by) VALUES ('mail_aliases', ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    JSON.stringify(aliases, null, 2),
    iso(),
    updatedBy
  );

// Cloudflare Email Routing addresses API. Without a token (dev/test) it logs and
// returns null, so aliases still work locally — like sendMail without a key.
async function cf<T>(env: Env, method: string, body?: unknown): Promise<T | null> {
  const path = `/accounts/${env.CF_ACCOUNT_ID}/email/routing/addresses`;
  if (!env.CF_EMAIL_TOKEN) {
    console.log(`[cf:dev] ${method} ${path}`);
    return null;
  }
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}${method === "GET" ? "?per_page=50" : ""}`, {
    method,
    headers: { Authorization: `Bearer ${env.CF_EMAIL_TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as { success: boolean; result: T; errors?: { message: string }[] };
  if (!json.success) fail(502, "bad_gateway", `Cloudflare: ${json.errors?.map((e) => e.message).join("; ")}`);
  return json.result;
}

// email → verified? for the account's Email Routing destination addresses.
async function destinations(env: Env): Promise<Map<string, boolean> | null> {
  const list = await cf<{ email: string; verified: string | null }[]>(env, "GET");
  return list && new Map(list.map((d) => [d.email.toLowerCase(), d.verified != null]));
}

const view = (env: Env, localPart: string, emails: string[], verified: Map<string, boolean> | null): MailAlias => ({
  local_part: localPart,
  address: `${localPart}@${env.MAIL_DOMAIN}`,
  forward_to: emails.map((email) => ({ email, verified: verified ? (verified.get(email) ?? false) : null })),
});

// Append a config event: body names the alias, from/to are its destination lists.
async function auditAlias(env: Env, actor: Actor, localPart: string, from: string[] | null, to: string[] | null) {
  await run(
    env.DB,
    `INSERT INTO events (subject_type, at, actor_id, actor_role, type, from_value, to_value, body, source)
       VALUES ('mail_alias', ?, ?, ?, 'config', ?, ?, ?, 'ui')`,
    iso(),
    actor.id,
    actor.role,
    from && JSON.stringify(from),
    to && JSON.stringify(to),
    localPart
  );
}

export async function listMailAliases(env: Env): Promise<MailAlias[]> {
  const [aliases, verified] = await Promise.all([readAliases(env), destinations(env)]);
  return Object.keys(aliases)
    .sort()
    .map((l) => view(env, l, aliases[l]!, verified));
}

// Create or replace. New destinations are registered with Cloudflare, which
// emails each a verification link; the Worker can only forward to verified ones.
export async function putMailAlias(env: Env, actor: Actor, localPart: string, forwardTo: string[]): Promise<MailAlias> {
  const verified = await destinations(env);
  for (const email of forwardTo) {
    if (!verified || verified.has(email)) continue;
    await cf(env, "POST", { email });
    verified.set(email, false);
  }

  const aliases = await readAliases(env);
  const before = aliases[localPart] ?? null;
  await writeAliases(env, { ...aliases, [localPart]: forwardTo }, actor.id);
  await auditAlias(env, actor, localPart, before, forwardTo);
  return view(env, localPart, forwardTo, verified);
}

export async function deleteMailAlias(env: Env, actor: Actor, localPart: string): Promise<boolean> {
  const { [localPart]: before, ...rest } = await readAliases(env);
  if (!before) return false;
  await writeAliases(env, rest, actor.id);
  await auditAlias(env, actor, localPart, before, null);
  return true;
}
