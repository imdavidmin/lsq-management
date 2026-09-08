import { env, applyD1Migrations } from "cloudflare:test";
import { beforeAll } from "vitest";

// Runs once per isolated storage snapshot; migrations (schema + seed) then
// persist into every test in the file.
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
