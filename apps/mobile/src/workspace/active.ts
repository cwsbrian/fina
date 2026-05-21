import AsyncStorage from "@react-native-async-storage/async-storage";
import { ACTIVE_WORKSPACE_STORAGE_KEY } from "@fina/shared";

const KEY = ACTIVE_WORKSPACE_STORAGE_KEY;

let cached: string | null = null;

export async function getActiveWorkspaceId(): Promise<string | null> {
  if (cached) return cached;
  const v = await AsyncStorage.getItem(KEY);
  cached = v;
  return v;
}

export async function setActiveWorkspaceId(id: string): Promise<void> {
  cached = id;
  await AsyncStorage.setItem(KEY, id);
}

export async function clearActiveWorkspaceId(): Promise<void> {
  cached = null;
  await AsyncStorage.removeItem(KEY);
}

export function clearActiveWorkspaceCache(): void {
  cached = null;
}
