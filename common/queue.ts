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

export const INBOUND_QUEUE = "lsq-inbound";
