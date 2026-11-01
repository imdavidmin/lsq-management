/// <reference types="@cloudflare/vitest-pool-workers" />

// Augment the pool-provided `cloudflare:test` env with our bindings. Declared
// as members (not `extends`) because heritage clauses don't merge into an
// already-declared interface.
declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    SNAPSHOTS: R2Bucket;
    OTP_LIMIT?: import("../src/lib/ratelimit").RateLimiter;
    API_LIMIT?: import("../src/lib/ratelimit").RateLimiter;
    EMAIL_DOMAIN: string;
    MAIL_FROM: string;
    BOARD_EMAIL: string;
    REPORT_DAY_OF_MONTH: string;
    MAILERSEND_API_KEY?: string;
    TEST_MIGRATIONS: D1Migration[];
  }
}

declare module "*.yaml?raw" {
  const content: string;
  export default content;
}
