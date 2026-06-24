import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "fina.excluded.seenTransactionIds.v1";

export async function getSeenExcludedIds(): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const ids = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

export async function rememberSeenExcludedIds(ids: string[]): Promise<void> {
  const seen = await getSeenExcludedIds();
  for (const id of ids) seen.add(id);
  await AsyncStorage.setItem(KEY, JSON.stringify([...seen]));
}
