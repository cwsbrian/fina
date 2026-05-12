const CA_CITIES = new Set([
  "toronto", "vancouver", "montreal", "calgary", "ottawa",
  "edmonton", "mississauga", "winnipeg", "quebec", "hamilton",
]);

function applyRules(input: string): string {
  let s = input.trim().toLowerCase();
  s = s.replace(/\s*\([^)]+\)\s*$/, "");
  s = s.replace(/\s+[a-z]{2}$/, "");
  s = s.replace(/\s+#\d+$/, "");
  s = s.replace(/\s+\d+$/, "");
  s = s.replace(/\s+[qrst]\d+$/, "");
  const cityMatch = s.match(/\s+([a-z]+)$/);
  if (cityMatch && CA_CITIES.has(cityMatch[1]!)) {
    s = s.slice(0, cityMatch.index!).trimEnd();
  }
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

const MAX_ITERS = 5;

export function normalizeMerchant(raw: string): string {
  let prev = raw;
  let curr = applyRules(prev);
  for (let i = 1; i < MAX_ITERS && curr !== prev; i++) {
    prev = curr;
    curr = applyRules(prev);
  }
  return curr;
}
