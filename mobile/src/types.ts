export type Player = { id: string; name: string; color: string };

export type GameInfo = {
  eventId: string;
  date: string;
  homeAbbrev: string;
  awayAbbrev: string;
  homeName: string;
  awayName: string;
};

export type Live = {
  state: 'pre' | 'in' | 'post' | string;
  detail: string;
  home: number;
  away: number;
  fetchedAt: number;
};

export type Winner = {
  home: number;
  away: number;
  row: number;
  col: number;
  playerId?: string;
};

export type BubbleEntry = {
  ts: number;
  home: number;
  away: number;
  detail: string;
  row: number;
  col: number;
  playerId?: string;
};

export type PoolState = {
  game?: GameInfo;
  players: Player[];
  assignments: string[];
  rowDigits?: number[];
  colDigits?: number[];
  revealed: boolean;
  winners: Record<string, Winner>;
  live?: Live | null;
  bubbleHistory: BubbleEntry[];
  bubbleIntervalSec: number;
};

export type Pool = {
  id: string;
  state: PoolState;
  createdAt: number;
  updatedAt: number;
};

export type CreatePoolResponse = Pool & {
  hostToken: string;
  hostPlayerId: string;
  hostPlayerToken: string;
};

export type JoinResponse = {
  playerId: string;
  playerToken: string;
  state: PoolState;
};

export type GameSummary = {
  eventId: string;
  date: string;
  name: string;
  homeAbbrev: string;
  awayAbbrev: string;
  homeName: string;
  awayName: string;
  state: string;
  detail: string;
};

export type WSMessage = { type: 'state'; pool: Pool };
