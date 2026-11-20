import { primaryRole } from "../../../common/roles";

type Actor = { actor_id: number | null; actor_email: string | null; actor_role: string | null };

// Resolves actor_role at read time for events from unknown email senders (D43):
// account email, then sender rules linked to an organisation (email before domain).
export async function emailRoles(db: D1Database) {
  const [people, rules, grants] = await Promise.all([
    db
      .prepare(
        `SELECT id, lower(email) AS email FROM accounts WHERE active = 1
         UNION SELECT a.id, lower(ae.email) FROM account_emails ae JOIN accounts a ON a.id = ae.account_id WHERE a.active = 1`
      )
      .all<{ id: number; email: string }>(),
    db
      .prepare(
        `SELECT s.match_type, lower(s.match_value) AS match_value, o.kind FROM senders s
           JOIN organizations o ON o.id = s.org_id WHERE s.status != 'ignored'`
      )
      .all<{ match_type: string; match_value: string; kind: string }>(),
    db.prepare("SELECT account_id, role_key FROM grants").all<{ account_id: number; role_key: string }>(),
  ]);

  const grantsOf = new Map<number, { role_key: string }[]>();
  for (const g of grants.results) grantsOf.set(g.account_id, [...(grantsOf.get(g.account_id) ?? []), g]);
  const accountRole = new Map(people.results.map((p) => [p.email, primaryRole(grantsOf.get(p.id) ?? [])]));
  const ruleRole = new Map(
    rules.results.map((r) => [`${r.match_type}:${r.match_value}`, r.kind === "agent" ? "agent" : "contractor"])
  );

  return <E extends Actor>(e: E): E => {
    if (e.actor_id != null || !e.actor_email) return e;
    const email = e.actor_email.toLowerCase();
    const role =
      accountRole.get(email) ?? ruleRole.get(`email:${email}`) ?? ruleRole.get(`domain:${email.slice(email.lastIndexOf("@") + 1)}`) ?? null;
    return { ...e, actor_role: role };
  };
}
