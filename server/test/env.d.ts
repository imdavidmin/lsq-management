/// <reference types="@cloudflare/vitest-pool-workers" />

// Augment the pool-provided `cloudflare:test` env with our bindings. Declared
// as members (not `extends`) because heritage clauses don't merge into an
// already-declared interface.
declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    SNAPSHOTS: R2Bucket;
    MAIL: R2Bucket;
    OTP_LIMIT?: import("../src/lib/ratelimit").RateLimiter;
    API_LIMIT?: import("../src/lib/ratelimit").RateLimiter;
    TICKET_EMAIL_DOMAIN: string;
    MAIL_FROM: string;
    MAIL_FROM_NAME: string;
    BOARD_EMAIL: string;
    MAIL_DOMAIN: string;
    CF_ACCOUNT_ID: string;
    CF_ZONE_ID: string;
    REPORT_DAY_OF_MONTH: string;
    MAILERSEND_API_KEY?: string;
    CF_EMAIL_TOKEN?: string;
    TEST_MIGRATIONS: D1Migration[];
  }
}

declare module "*.yaml?raw" {
  const content: string;
  export default content;
}
