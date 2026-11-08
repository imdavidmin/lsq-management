// Contract for the inbound-email queue: produced by the email Worker, consumed
// by the ai Worker. Kept dependency-free so both bundles can import it.
//
// The raw RFC822 message is stashed in R2 (Queue messages cap at 128 KB and
// mail can carry large attachments); only its key travels on the queue.
export interface InboundEmail {
  ticketId: number; // already validated to exist by the email Worker
  from: string; // lowercased From address
  subject: string;
  rawKey: string; // R2 object key holding the full raw message
}

// Main-domain inboxes whose mail from a known account opens a ticket (D32).
export const TRIAGE_INBOXES = ["management", "concierge"] as const;
export type TriageInbox = (typeof TRIAGE_INBOXES)[number];

// Mail to a triage inbox; already forwarded to the alias's destinations.
export interface TriageEmail {
  inbox: TriageInbox;
  accountId: number; // the sender's account, resolved by the email Worker
  from: string;
  subject: string;
  rawKey: string;
}

export type QueuedEmail = InboundEmail | TriageEmail;

export const INBOUND_QUEUE = "lsq-inbound";
