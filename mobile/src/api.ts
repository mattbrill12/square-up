import Constants from 'expo-constants';
import type {
  CreatePoolResponse,
  GameSummary,
  JoinResponse,
  Pool,
} from './types';

const extra = Constants.expoConfig?.extra as { apiUrl?: string } | undefined;

export const API_URL: string =
  process.env.EXPO_PUBLIC_API_URL || extra?.apiUrl || 'http://localhost:8080';

async function call<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const r = await fetch(API_URL + path, opts);
  if (!r.ok) {
    const msg = await r.text();
    throw new Error(`${r.status}: ${msg}`);
  }
  return r.json() as Promise<T>;
}

export function listGames(): Promise<{ games: GameSummary[] }> {
  return call('/api/games/today');
}

export function createPool(
  eventId: string,
  hostName: string,
  bubbleIntervalSec: number,
): Promise<CreatePoolResponse> {
  return call('/api/pools', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventId, hostName, bubbleIntervalSec }),
  });
}

export function getPool(id: string): Promise<Pool> {
  return call(`/api/pools/${id}`);
}

export function joinPool(id: string, name: string): Promise<JoinResponse> {
  return call(`/api/pools/${id}/players`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export function patchPool(
  id: string,
  hostToken: string,
  patch: Record<string, unknown>,
): Promise<Pool> {
  return call(`/api/pools/${id}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${hostToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(patch),
  });
}

export function claimSquare(
  id: string,
  idx: number,
  token: string,
  forPlayerId?: string,
): Promise<Pool> {
  return call(`/api/pools/${id}/squares/${idx}/claim`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(forPlayerId ? { playerId: forPlayerId } : {}),
  });
}

export function unclaimSquare(id: string, idx: number, token: string): Promise<Pool> {
  return call(`/api/pools/${id}/squares/${idx}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export function setPushToken(
  id: string,
  playerId: string,
  token: string,
  expoToken: string,
): Promise<unknown> {
  return call(`/api/pools/${id}/players/${playerId}/push-token`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ token: expoToken }),
  });
}
