import { useEffect, useState } from "react";
import { makeApiFetch, type MeDTO, type WorkspaceSummary } from "@fina/shared";
import { env } from "../env";
import { getActiveWorkspaceId } from "./active-workspace";

// Re-export the canonical types so existing imports `import type { Me }
// from "../lib/api"` keep working with the shared shapes underneath.
export type Me = MeDTO;
export type { ApiError } from "@fina/shared";

export const apiFetch = makeApiFetch({
  baseUrl: env.NEXT_PUBLIC_API_URL,
  getActiveWorkspaceId,
  withCredentials: true,
});

export async function bootstrapActiveWorkspace(): Promise<string | null> {
  // Always reconcile against the live list — a stored id from a workspace the
  // user has since left would otherwise return 404 forever.
  const data = await apiFetch<{ workspaces: WorkspaceSummary[] }>("/workspaces");
  const ids = new Set(data.workspaces.map((w) => w.id));
  const existing = getActiveWorkspaceId();
  const { setActiveWorkspaceId, clearActiveWorkspaceId } = await import("./active-workspace");
  if (existing && ids.has(existing)) return existing;
  const first = data.workspaces[0]?.id ?? null;
  if (first) {
    setActiveWorkspaceId(first);
  } else {
    clearActiveWorkspaceId();
  }
  return first;
}

export function useMe(): { me: Me | null; err: string | null } {
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    apiFetch<Me>("/me")
      .then(setMe)
      .catch((e) => setErr((e as { code?: string }).code ?? "error"));
  }, []);
  return { me, err };
}

/**
 * Reconciled active workspace id. Returns null until bootstrap completes.
 */
export function useActiveWorkspaceId(): string | null {
  const [wsId, setWsId] = useState<string | null>(null);
  useEffect(() => {
    bootstrapActiveWorkspace()
      .then((id) => setWsId(id ?? getActiveWorkspaceId()))
      .catch(() => setWsId(null));
  }, []);
  return wsId;
}
