import { readD1Migrations } from "@cloudflare/vitest-pool-workers/config";
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import path from "node:path";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
  return {
    test: {
      setupFiles: ["./server/test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          isolatedStorage: true,
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            // TEST_MIGRATIONS applied in setup. Blank DEV_LOGIN_EMAIL so the
            // .dev.vars auth bypass (session.ts) never leaks into tests.
            bindings: { TEST_MIGRATIONS: migrations, DEV_LOGIN_EMAIL: "" },
          },
        },
      },
    },
  };
});
