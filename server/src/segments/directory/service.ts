import type { Env } from "../../env";
import { all, one, run, grantsForAccount } from "../../db/client";
import type { Account, Grant } from "../../db/client";
import { sendMail } from "../auth/mailer";

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
  all<Account>(env.DB, "SELECT id, email, name, active FROM accounts ORDER BY name");

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
  const accounts = await all<Account>(env.DB, "SELECT id, name, active FROM accounts ORDER BY name");
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
    ...(reveal.email ? { email: a.email } : {}),
    grants: reveal.units ? grants : grants.filter((g) => g.scope_type !== "unit"),
    ...(reveal.units ? { units: units ?? [] } : {}),
  };
}

export const getAccount = (env: Env, id: number) =>
  one<Account>(env.DB, "SELECT id, email, name, active FROM accounts WHERE id = ?", id);

export const accountByEmail = (env: Env, email: string) =>
  one<Account>(env.DB, "SELECT id, email, name, active FROM accounts WHERE email = ?", email.toLowerCase());

export async function createAccount(env: Env, email: string, name: string): Promise<Account> {
  const res = await run(
    env.DB,
    "INSERT INTO accounts (email, name, active) VALUES (?, ?, 1)",
    email.toLowerCase(),
    name
  );
  return (await getAccount(env, res.meta.last_row_id as number))!;
}

// Onboard a resident: create the account, associate them with their unit via a
// resident grant, and email an invitation. Activation is the passwordless OTP
// flow (docs/authentication.md), so the invite just points them at sign-in —
// no separate activation token.
export async function inviteAccount(
  env: Env,
  a: { email: string; name: string; unit_id?: number | null; loginUrl: string }
): Promise<Account> {
  const account = await createAccount(env, a.email, a.name);
  if (a.unit_id != null) {
    await run(
      env.DB,
      "INSERT INTO grants (account_id, role_key, scope_type, scope_id) VALUES (?, 'resident', 'unit', ?)",
      account.id,
      a.unit_id
    );
  }
  await sendMail(env, {
    to: account.email,
    subject: "You've been invited to Lansbury Square",
    text:
      `Hi ${a.name},\n\n` +
      `An account has been created for you on the Lansbury Square resident portal.\n` +
      `To activate it, sign in with this email address at:\n\n${a.loginUrl}\n\n` +
      `You'll be sent a one-time login code — no password needed.\n`,
  });
  return account;
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

export async function deleteSender(env: Env, id: number): Promise<boolean> {
  const res = await run(env.DB, "DELETE FROM senders WHERE id = ?", id);
  return (res.meta.changes ?? 0) > 0;
}
