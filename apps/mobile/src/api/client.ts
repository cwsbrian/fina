import {
  CLIENT_DEVICE_ID_HEADER,
  CLIENT_PLATFORM_HEADER,
  makeApiFetch,
  type WorkspaceSummary,
} from "@fina/shared";
import { Platform } from "react-native";
import { authClient } from "../auth/client";
import { env } from "../env";
import { getClientDeviceId } from "../device/client-device";
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
  getExtraHeaders: async () => {
    if (Platform.OS !== "ios" && Platform.OS !== "android") return null;
    return {
      [CLIENT_DEVICE_ID_HEADER]: await getClientDeviceId(),
      [CLIENT_PLATFORM_HEADER]: Platform.OS,
    };
  },
});

export async function bootstrapActiveWorkspace(): Promise<string | null> {
  return (await bootstrapActiveWorkspaceSummary())?.id ?? null;
}

export async function bootstrapActiveWorkspaceSummary(): Promise<WorkspaceSummary | null> {
  // Always reconcile against the live list — a stored id from a workspace the
  // user has since left would otherwise return 404 forever.
  const data = await apiFetch<{ workspaces: WorkspaceSummary[] }>("/workspaces");
  const existing = await getActiveWorkspaceId();
  const active = data.workspaces.find((w) => w.id === existing);
  if (active) return active;
  const first = data.workspaces[0] ?? null;
  if (first) {
    await setActiveWorkspaceId(first.id);
  } else {
    await clearActiveWorkspaceId();
  }
  return first;
}
