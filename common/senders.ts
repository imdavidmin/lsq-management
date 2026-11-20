// Personal mail domains (D29), used by the directory routes to flag likely residents.
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
