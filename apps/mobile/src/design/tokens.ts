// Fina Design System — mirrors apps/web/src/app/global.css and the
// design workspace's system/colors_and_type.css.
export const colors = {
  primary: "#3eb38b",            // Fina mint
  primaryActive: "#2e9577",
  primaryDisabled: "#b8e0cd",
  mint: "#7dd8b8",               // bright accent
  navy: "#1c2f45",               // secondary trust
  softBlue: "#8fb8e8",           // AI / chat tint
  accentYellow: "#e6b85c",       // coin / money hint

  canvas: "#fbfcfb",
  surfaceSoft: "#f3f5f3",
  surfaceStrong: "#e7ebe7",
  surfaceDark: "#15201e",
  surfaceDarkElevated: "#1f2c2a",

  hairline: "#dfe4df",
  hairlineSoft: "#ecefec",

  ink: "#15201e",
  body: "#4f5853",
  bodyStrong: "#15201e",
  muted: "#6f7a76",
  mutedSoft: "#a0a9a4",
  onPrimary: "#ffffff",
  onDark: "#ffffff",
  onDarkSoft: "#a8b0aa",

  up: "#1f8a5b",     // text-only — never a background fill
  down: "#cf202f",   // text-only — never a background fill
} as const;

export const space = {
  xxs: 4,
  xs: 8,
  sm: 12,
  base: 16,
  md: 20,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const radius = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  pill: 100,
  full: 9999,
} as const;

export const shadowSoft = {
  shadowColor: "#000",
  shadowOpacity: 0.04,
  shadowOffset: { width: 0, height: 4 },
  shadowRadius: 12,
  elevation: 2,
};

export const type = {
  displaySm: { fontSize: 36, lineHeight: 40, fontWeight: "400" as const, letterSpacing: -0.8 },
  titleLg: { fontSize: 32, lineHeight: 36, fontWeight: "500" as const, letterSpacing: -0.4 },
  titleMd: { fontSize: 18, lineHeight: 24, fontWeight: "600" as const },
  titleSm: { fontSize: 16, lineHeight: 20, fontWeight: "600" as const },
  bodyMd: { fontSize: 16, lineHeight: 24, fontWeight: "400" as const },
  bodySm: { fontSize: 14, lineHeight: 21, fontWeight: "400" as const },
  caption: { fontSize: 13, lineHeight: 20, fontWeight: "400" as const },
  captionStrong: { fontSize: 12, lineHeight: 18, fontWeight: "600" as const, letterSpacing: 0.3 },
  button: { fontSize: 16, lineHeight: 18, fontWeight: "600" as const },
  authTitle: { fontSize: 30, lineHeight: 34, fontWeight: "500" as const, letterSpacing: -0.8 },
  otpDigit: { fontSize: 28, lineHeight: 28, fontWeight: "500" as const, letterSpacing: -0.6 },
} as const;
