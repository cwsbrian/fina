export function notificationRouteForData(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const payload = data as Record<string, unknown>;
  if (payload.type === "daily-spending") return "/(tabs)";
  if (payload.type !== "daily-brief") return null;

  const threadId = typeof payload.threadId === "string" ? payload.threadId.trim() : "";
  if (!threadId) return null;

  return `/(tabs)/chat?thread=${encodeURIComponent(threadId)}`;
}
