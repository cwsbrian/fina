export function isBackendUnavailableError(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { status?: unknown }).status === 0 &&
    (e as { code?: unknown }).code === "network_unreachable"
  );
}
