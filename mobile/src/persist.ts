import * as SecureStore from 'expo-secure-store';

export type PoolCreds = {
  hostToken?: string;
  playerId?: string;
  playerToken?: string;
};

export type RecentEntry = {
  id: string;
  label: string;
  createdAt: number;
};

const credsKey = (poolId: string) => `pool_${poolId.replace(/[^a-zA-Z0-9]/g, '_')}`;
const RECENT_KEY = 'recent_pools';

export async function saveCreds(poolId: string, creds: PoolCreds): Promise<void> {
  await SecureStore.setItemAsync(credsKey(poolId), JSON.stringify(creds));
}

export async function loadCreds(poolId: string): Promise<PoolCreds | null> {
  const raw = await SecureStore.getItemAsync(credsKey(poolId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PoolCreds;
  } catch {
    return null;
  }
}

export async function clearCreds(poolId: string): Promise<void> {
  await SecureStore.deleteItemAsync(credsKey(poolId));
}

export async function listRecent(): Promise<RecentEntry[]> {
  const raw = await SecureStore.getItemAsync(RECENT_KEY);
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
  await SecureStore.setItemAsync(RECENT_KEY, JSON.stringify(next));
}

export async function dropRecent(poolId: string): Promise<void> {
  const current = await listRecent();
  const next = current.filter((e) => e.id !== poolId);
  await SecureStore.setItemAsync(RECENT_KEY, JSON.stringify(next));
}
