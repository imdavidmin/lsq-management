// OTP code format — shared so server validation and the web input can't drift.
export const OTP_LENGTH = 6;
export const OTP_PATTERN = `[0-9]{${OTP_LENGTH}}`; // HTML input pattern (no anchors)
export const OTP_REGEX = new RegExp(`^${OTP_PATTERN}$`); // full-string validation
