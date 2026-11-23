// Idempotently create the board members in the gitignored board.local.json, so a D1 wipe never locks everyone out.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const members = JSON.parse(readFileSync(new URL("./board.local.json", import.meta.url), "utf8"))
  .map((m) => ({ email: m.email.trim().toLowerCase(), name: m.name.trim() }));

const q = (s) => `'${s.replaceAll("'", "''")}'`;
const sql = members
  .map(({ email, name }) => `INSERT INTO accounts (email, name) VALUES (${q(email)}, ${q(name)})
  ON CONFLICT(email) DO UPDATE SET name = excluded.name;
INSERT INTO grants (account_id, role_key, scope_type)
  SELECT a.id, 'board', 'estate' FROM accounts a WHERE a.email = ${q(email)}
     AND NOT EXISTS (SELECT 1 FROM grants g WHERE g.account_id = a.id AND g.role_key = 'board' AND g.scope_type = 'estate');`)
  .join("\n");

execFileSync("npx", ["wrangler", "d1", "execute", "DB", process.argv[2] ?? "--local", "--command", sql], { stdio: "inherit" });
