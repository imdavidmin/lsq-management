/// <reference types="@cloudflare/vitest-pool-workers" />

// The Vitest pool runs these tests in the shared server Worker env, so DB is the
// migrated D1. R2/Queue/AI are injected as fakes by each test.
declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
  }
}
