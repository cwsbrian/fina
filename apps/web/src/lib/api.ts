import { useEffect, useState } from "react";
import { env } from "../env";
import { getActiveWorkspaceId } from "./active-workspace";

export type ApiError = { status: number; code: string; message?: string };

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const wsId = getActiveWorkspaceId();
  // Only declare content-type when there's actually a body — otherwise Fastify
  // 5 rejects body-less POST/DELETE/PATCH with 400 "Body cannot be empty when
  // content-type is set to 'application/json'".
  const hasBody = init.body !== undefined && init.body !== null;
  const res = await fetch(`${env.NEXT_PUBLIC_API_URL}${path}`, {
    ...init,
    credentials: "include",
    cache: "no-store",
    headers: {
      ...(hasBody ? { "content-type": "application/json" } : {}),
      ...(wsId ? { "x-workspace-id": wsId } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) {
    let body: { error?: string; message?: string } = {};
    try {
      body = await res.json();
    } catch {
      // ignore — body might not be json
    }
    const err: ApiError = {
      status: res.status,
      code: body.error ?? `http_${res.status}`,
      ...(body.message !== undefined ? { message: body.message } : {}),
    };
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function bootstrapActiveWorkspace(): Promise<string | null> {
  // Always reconcile against the live list — a stored id from a workspace the
  // user has since left would otherwise return 404 forever.
  const data = await apiFetch<{ workspaces: { id: string; name: string; role: string }[] }>(
    "/workspaces",
  );
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

export type Me = {
  user: { id: string; email: string; tz: string; locale: string };
  tier: "free" | "lite" | "pro";
  trial: { active: boolean; endsAt: string | null };
};

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
