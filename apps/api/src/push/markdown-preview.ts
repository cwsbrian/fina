/** Strip markdown syntax + collapse newlines + truncate, for use as the
 *  body of a push notification where OS limits visible characters to
 *  ~120-180 depending on platform. Naive implementation — e.g., `5*3=15`
 *  becomes `53=15` — acceptable for brief content which is prose. */
export function markdownToPlainPreview(md: string, max = 120): string {
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
