import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

export type PoolCreds = {
  hostToken?: string;
  playerId?: string;
  playerToken?: string;
  /** Watching only — no seat, no name in the lobby, no edit permissions. */
  observer?: boolean;
};

export type RecentEntry = {
  id: string;
  label: string;
  createdAt: number;
};

const credsKey = (poolId: string) => `pool_${poolId.replace(/[^a-zA-Z0-9]/g, '_')}`;
const RECENT_KEY = 'recent_pools';

// expo-secure-store doesn't have a web implementation — fall back to localStorage
// on web. SecureStore on native gives us OS keychain encryption; on web we use
// the standard browser store, which is fine for a friends-drinking-game token.

async function getItem(key: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage.getItem(key);
  }
  return SecureStore.getItemAsync(key);
}

async function setItem(key: string, value: string): Promise<void> {
  if (Platform.OS === 'web') {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(key, value);
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

async function deleteItem(key: string): Promise<void> {
  if (Platform.OS === 'web') {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.removeItem(key);
    return;
  }
  await SecureStore.deleteItemAsync(key);
}

export async function saveCreds(poolId: string, creds: PoolCreds): Promise<void> {
  await setItem(credsKey(poolId), JSON.stringify(creds));
}

export async function loadCreds(poolId: string): Promise<PoolCreds | null> {
  const raw = await getItem(credsKey(poolId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PoolCreds;
  } catch {
    return null;
  }
}

export async function clearCreds(poolId: string): Promise<void> {
  await deleteItem(credsKey(poolId));
}

export async function listRecent(): Promise<RecentEntry[]> {
  const raw = await getItem(RECENT_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as RecentEntry[];
  } catch {
    return [];
  }
}

export async function pushRecent(entry: RecentEntry): Promise<void> {
  const current = await listRecent();
  const next = [entry, ...current.filter((e) => e.id !== entry.id)].slice(0, 10);
  await setItem(RECENT_KEY, JSON.stringify(next));
}

export async function dropRecent(poolId: string): Promise<void> {
  const current = await listRecent();
  const next = current.filter((e) => e.id !== poolId);
  await setItem(RECENT_KEY, JSON.stringify(next));
}
