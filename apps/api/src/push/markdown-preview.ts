/** Visible-character cap for push notification bodies. iOS truncates around
 *  178 chars (banner) / 230 chars (expanded); Android wraps at ~180. 120 is
 *  a conservative cross-platform default that fits on one line on both. */
export const BRIEF_PUSH_PREVIEW_CHARS = 120;

/** Strip markdown syntax + collapse newlines + truncate, for use as the
 *  body of a push notification. Naive implementation — e.g., `5*3=15`
 *  becomes `53=15` — acceptable for brief content which is prose. */
export function markdownToPlainPreview(md: string, max = BRIEF_PUSH_PREVIEW_CHARS): string {
  const cleaned = md
    // Convert [text](url) → text BEFORE stripping link chars.
    .replace(/\[(.+?)\]\(.+?\)/g, "$1")
    // Strip common markdown markers.
    .replace(/[*_#`~>]/g, "")
    // Split on newlines, trim + collapse spaces within each segment, rejoin.
    .split("\n")
    .map((seg) => seg.trim().replace(/ +/g, " "))
    .join(" ")
    .trim();

  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max) + "…";
}
