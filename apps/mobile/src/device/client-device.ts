import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";

const CLIENT_DEVICE_ID_KEY = "fina-client-device-id";

function fallbackId(): string {
  return `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export async function getClientDeviceId(): Promise<string> {
  const existing = await AsyncStorage.getItem(CLIENT_DEVICE_ID_KEY);
  if (existing) return existing;
  const next =
    typeof Crypto.randomUUID === "function" ? Crypto.randomUUID() : fallbackId();
  await AsyncStorage.setItem(CLIENT_DEVICE_ID_KEY, next);
  return next;
}
