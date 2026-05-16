// Rough heuristic: 4 chars ≈ 1 token. Safety valve against pathological
// tool-result payloads. NOT for billing or precise budgeting.
export function estimateMessageTokens(blocks: unknown): number {
  return Math.ceil(JSON.stringify(blocks).length / 4);
}
