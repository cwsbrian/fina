import { useEffect, useState } from "react";
import {
  isApiError,
  makeApiFetch,
  type MeDTO,
  type WorkspaceSummary,
} from "@fina/shared";
import { toast } from "sonner";
import { env } from "../env";
import { getActiveWorkspaceId } from "./active-workspace";

// Re-export the canonical types so existing imports `import type { Me }
// from "../lib/api"` keep working with the shared shapes underneath.
export type Me = MeDTO;
export type { ApiError } from "@fina/shared";

const rawApiFetch = makeApiFetch({
  baseUrl: env.NEXT_PUBLIC_API_URL,
  getActiveWorkspaceId,
  withCredentials: true,
});

function parseRetryAfter(msg: string): number | null {
  const m = msg.match(/Retry in (\d+)s/);
  return m ? Number(m[1]) : null;
}

export const apiFetch: typeof rawApiFetch = async (...args) => {
  try {
    return await rawApiFetch(...args);
  } catch (err) {
    if (isApiError(err) && err.code === "rate_limit_exceeded") {
      const secs = parseRetryAfter(err.message ?? "");
      toast.error(
        secs !== null
          ? `잠시 후 다시 시도해 주세요 (${secs}초 후)`
          : "잠시 후 다시 시도해 주세요",
      );
    }
    throw err;
  }
};

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
