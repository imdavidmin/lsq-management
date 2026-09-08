import {
  createDarkTheme,
  createLightTheme,
  type BrandVariants,
  type Theme,
} from "@fluentui/react-components";

// Warm brand accent ramp (a muted terracotta/amber) — consumer-friendly but
// still professional. Generated as a standard 16-step Fluent brand ramp.
const brand: BrandVariants = {
  10: "#050200",
  20: "#221206",
  30: "#3b1c07",
  40: "#4f2408",
  50: "#642d09",
  60: "#7a370a",
  70: "#90410b",
  80: "#a74c0c",
  90: "#bd5a1a",
  100: "#cd6b31",
  110: "#d97d49",
  120: "#e39061",
  130: "#eca47b",
  140: "#f3b896",
  150: "#f9ccb3",
  160: "#fde1d1",
};

// Soften: larger radii, lighter shadows. Applied to both themes so the whole
// app inherits the token overrides via FluentProvider.
const overrides = {
  borderRadiusMedium: "8px",
  borderRadiusLarge: "12px",
  borderRadiusXLarge: "16px",
  shadow4: "0 1px 2px rgba(0,0,0,0.06)",
  shadow8: "0 2px 8px rgba(0,0,0,0.08)",
  shadow16: "0 4px 16px rgba(0,0,0,0.08)",
  shadow28: "0 8px 28px rgba(0,0,0,0.10)",
};

export const lsqTheme: Theme = { ...createLightTheme(brand), ...overrides };
export const lsqDarkTheme: Theme = { ...createDarkTheme(brand), ...overrides };
