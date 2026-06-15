export const HERO_FRAME_START_SECONDS = 6;
export const HERO_FRAME_END_SECONDS = 10;
export const HERO_FRAME_COUNT = 48;
export const HERO_FIRST_FRAME_SOURCE =
  "/landing/hero-sequence/hero-0001.webp";

export const HERO_FRAME_SOURCES = Array.from(
  { length: HERO_FRAME_COUNT },
  (_, index) =>
    `/landing/hero-sequence/hero-${String(index + 1).padStart(4, "0")}.webp`,
);

export function heroFrameForProgress(progress: number) {
  const clamped = Math.min(1, Math.max(0, progress));
  return Math.round(clamped * (HERO_FRAME_COUNT - 1));
}
