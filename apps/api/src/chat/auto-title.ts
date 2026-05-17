const MAX_LEN = 200; // matches chat_threads.title TEXT(200) cap

// Pure: First non-empty line, strip matched outer quotes, trim, cap to MAX_LEN.
// Returns null if nothing meaningful remains.
export function cleanTitle(raw: string): string | null {
  if (!raw) return null;
  let line = "";
  for (const candidate of raw.split("\n")) {
    if (candidate.trim().length > 0) {
      line = candidate;
      break;
    }
  }
  let s = line.trim();
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      s = s.slice(1, -1).trim();
    }
  }
  if (s.length === 0) return null;
  if (s.length > MAX_LEN) return s.slice(0, MAX_LEN);
  return s;
}
