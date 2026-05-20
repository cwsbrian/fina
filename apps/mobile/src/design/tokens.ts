export const colors = {
  primary: "#3b7bff",
  primaryActive: "#2a64db",
  primaryDisabled: "#bccae0",
  accentYellow: "#f4b000",

  canvas: "#ffffff",
  surfaceSoft: "#f7f7f7",
  surfaceStrong: "#eef0f3",
  surfaceDark: "#0a0b0d",
  surfaceDarkElevated: "#16181c",

  hairline: "#dee1e6",
  hairlineSoft: "#eef0f3",

  ink: "#0a0b0d",
  body: "#5b616e",
  bodyStrong: "#0a0b0d",
  muted: "#7c828a",
  mutedSoft: "#a8acb3",
  onPrimary: "#ffffff",
  onDark: "#ffffff",
  onDarkSoft: "#a8acb3",

  up: "#05b169",
  down: "#cf202f",
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
