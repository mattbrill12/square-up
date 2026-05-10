import Constants from 'expo-constants';
import type {
  CreatePoolResponse,
  GameSummary,
  JoinResponse,
  Pool,
} from './types';

const extra = Constants.expoConfig?.extra as { apiUrl?: string } | undefined;

function detectApiUrl(): string {
  if (process.env.EXPO_PUBLIC_API_URL) return process.env.EXPO_PUBLIC_API_URL;
  // On web, when served from a non-localhost origin, talk to the same origin.
  // The Go backend serves the bundle and the API together in production.
  if (typeof window !== 'undefined' && window.location?.origin) {
    const origin = window.location.origin;
    if (!origin.includes('localhost') && !origin.includes('127.0.0.1')) {
      return origin;
    }
  }
  return extra?.apiUrl || 'http://localhost:8080';
}

export const API_URL: string = detectApiUrl();

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
  additionalPlayers: string[] = [],
): Promise<CreatePoolResponse> {
  return call('/api/pools', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventId, hostName, bubbleIntervalSec, additionalPlayers }),
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

export function claimSeat(
  id: string,
  playerId: string,
  name?: string,
): Promise<JoinResponse> {
  return call(`/api/pools/${id}/players/${playerId}/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(name ? { name } : {}),
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

export function mockLive(
  id: string,
  hostToken: string,
  payload: { state: 'pre' | 'in' | 'post'; home: number; away: number; detail: string; sample?: boolean },
): Promise<Pool> {
  return call(`/api/pools/${id}/mock-live`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${hostToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

export function isLocalApiUrl(): boolean {
  const u = API_URL.toLowerCase();
  return (
    u.includes('localhost') ||
    u.includes('127.0.0.1') ||
    u.includes('192.168.') ||
    /\b10\.\d/.test(u)
  );
}

export function renamePlayer(
  id: string,
  playerId: string,
  hostToken: string,
  name: string,
): Promise<Pool> {
  return call(`/api/pools/${id}/players/${playerId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${hostToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name }),
  });
}

export function removePlayer(id: string, playerId: string, hostToken: string): Promise<Pool> {
  return call(`/api/pools/${id}/players/${playerId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${hostToken}` },
  });
}

export function snapshotNow(id: string, hostToken: string): Promise<Pool> {
  return call(`/api/pools/${id}/snapshot`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${hostToken}` },
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
