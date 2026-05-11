import { authClient } from "../auth/client";
import { env } from "../env";
import { getActiveWorkspaceId } from "../workspace/active";

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const cookie = (authClient as { getCookie?: () => string }).getCookie?.() ?? "";
  const wsId = await getActiveWorkspaceId();
  // Only declare content-type when there's actually a body — otherwise Fastify 5
  // rejects body-less POST/DELETE/PATCH with 400 "Body cannot be empty".
  const hasBody = init.body !== undefined && init.body !== null;
  const res = await fetch(`${env.EXPO_PUBLIC_API_URL}${path}`, {
    ...init,
    headers: {
      ...(hasBody ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...(wsId ? { "x-workspace-id": wsId } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

export async function bootstrapActiveWorkspace(): Promise<string | null> {
  // Always reconcile against the live list — a stored id from a workspace the
  // user has since left would otherwise return 404 forever.
  const data = await apiFetch<{ workspaces: { id: string; name: string; role: string }[] }>(
    "/workspaces",
  );
  const ids = new Set(data.workspaces.map((w) => w.id));
  const existing = await getActiveWorkspaceId();
  const { setActiveWorkspaceId, clearActiveWorkspaceId } = await import("../workspace/active");
  if (existing && ids.has(existing)) return existing;
  const first = data.workspaces[0]?.id ?? null;
  if (first) {
    await setActiveWorkspaceId(first);
  } else {
    await clearActiveWorkspaceId();
  }
  return first;
}
