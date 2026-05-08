import { authClient } from "../auth/client";
import { env } from "../env";

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const cookie = (authClient as { getCookie?: () => string }).getCookie?.() ?? "";
  const res = await fetch(`${env.EXPO_PUBLIC_API_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}
