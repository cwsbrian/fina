import { makeApiFetch, type WorkspaceSummary } from "@fina/shared";
import { authClient } from "../auth/client";
import { env } from "../env";
import {
  getActiveWorkspaceId,
  setActiveWorkspaceId,
  clearActiveWorkspaceId,
} from "../workspace/active";

export const apiFetch = makeApiFetch({
  baseUrl: env.EXPO_PUBLIC_API_URL,
  getActiveWorkspaceId,
  getCookieHeader: () =>
    (authClient as { getCookie?: () => string }).getCookie?.() ?? null,
});

export async function bootstrapActiveWorkspace(): Promise<string | null> {
  // Always reconcile against the live list — a stored id from a workspace the
  // user has since left would otherwise return 404 forever.
  const data = await apiFetch<{ workspaces: WorkspaceSummary[] }>("/workspaces");
  const ids = new Set(data.workspaces.map((w) => w.id));
  const existing = await getActiveWorkspaceId();
  if (existing && ids.has(existing)) return existing;
  const first = data.workspaces[0]?.id ?? null;
  if (first) {
    await setActiveWorkspaceId(first);
  } else {
    await clearActiveWorkspaceId();
  }
  return first;
}
