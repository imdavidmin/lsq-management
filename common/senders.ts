// Default SLA role for an inbound sender we can't identify (D29): personal mail
// domains are most likely residents, anything else a business (contractor).
// Dependency-free so the ai Worker can import it.
const PERSONAL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "hotmail.com",
  "hotmail.co.uk",
  "outlook.com",
  "live.com",
  "live.co.uk",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "yahoo.com",
  "yahoo.co.uk",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "btinternet.com",
  "sky.com",
  "virginmedia.com",
  "talktalk.net",
  "gmx.com",
]);

export const isPersonalDomain = (domain: string) => PERSONAL_DOMAINS.has(domain.toLowerCase());

export function defaultRole(email: string): "resident" | "contractor" {
  return isPersonalDomain(email.slice(email.lastIndexOf("@") + 1)) ? "resident" : "contractor";
}
