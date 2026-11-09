export interface Env {
  DB: D1Database;
  SNAPSHOTS: R2Bucket; // year-end score snapshots (D21)
  MAIL: R2Bucket; // inbound mail originals + attachments, read-only here except erasure deletes originals (D28, D30)
  ASSETS?: Fetcher; // built web/dist (SPA); absent in tests. See app.ts notFound.
  OTP_LIMIT?: import("./lib/ratelimit").RateLimiter; // per-IP/email OTP cap
  API_LIMIT?: import("./lib/ratelimit").RateLimiter; // lax global per-IP cap
  // vars
  TICKET_EMAIL_DOMAIN: string;
  MAIL_FROM: string;
  MAIL_FROM_NAME: string;
  APP_URL: string; // live site, for links and the logo in mail (D35)
  BOARD_EMAIL: string;
  MAIL_DOMAIN: string; // board-provisioned aliases (D26)
  CF_ACCOUNT_ID: string;
  CF_ZONE_ID: string;
  REPORT_DAY_OF_MONTH: string; // day-of-month the monthly report fires
  // secrets
  MAILERSEND_API_KEY?: string;
  CF_EMAIL_TOKEN?: string; // registers Email Routing destination addresses (D26)
}

// Hono variables set by middleware and read by handlers.
export interface Vars {
  account: import("./db/client").Account;
  grants: import("./db/client").Grant[];
}

export type AppContext = { Bindings: Env; Variables: Vars };
