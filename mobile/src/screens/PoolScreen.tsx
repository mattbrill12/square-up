import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import * as Clipboard from 'expo-clipboard';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import type { RootStackParamList } from '../../App';
import {
  claimSquare,
  getPool,
  patchPool,
  setPushToken as apiSetPushToken,
  unclaimSquare,
} from '../api';
import { dropRecent, loadCreds, type PoolCreds } from '../persist';
import { getExpoPushToken } from '../push';
import { PoolStore } from '../store';
import { theme } from '../theme';
import type { BubbleEntry, Player, Pool, PoolState } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'Pool'>;

const QUARTER_LABELS: Record<string, string> = {
  q1: 'Q1',
  q2: 'Halftime',
  q3: 'Q3',
  final: 'Final',
};

export default function PoolScreen({ navigation, route }: Props) {
  const { poolId } = route.params;
  const [pool, setPool] = useState<Pool | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creds, setCreds] = useState<PoolCreds | null>(null);
  const [busyIdx, setBusyIdx] = useState<number | null>(null);
  const storeRef = useRef<PoolStore | null>(null);

  // Load + connect WS once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const c = await loadCreds(poolId);
        if (!c?.playerToken && !c?.hostToken) {
          if (!cancelled) navigation.replace('Join', { poolId });
          return;
        }
        const initial = await getPool(poolId);
        if (cancelled) return;
        const store = new PoolStore(initial);
        storeRef.current = store;
        const unsub = store.subscribe(setPool);
        store.connect();
        setCreds(c);
        return () => {
          unsub();
          store.disconnect();
        };
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes('404')) {
          await dropRecent(poolId);
          if (!cancelled) setError('Pool no longer exists.');
        } else if (!cancelled) {
          setError(msg);
        }
      }
    })();
    return () => {
      cancelled = true;
      storeRef.current?.disconnect();
    };
  }, [poolId, navigation]);

  // Register Expo push token once we know who we are.
  useEffect(() => {
    if (!creds?.playerId || !creds.playerToken) return;
    let cancelled = false;
    (async () => {
      const token = await getExpoPushToken();
      if (!token || cancelled) return;
      try {
        await apiSetPushToken(poolId, creds.playerId!, creds.playerToken!, token);
      } catch {
        // best-effort; don't block UI
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [poolId, creds?.playerId, creds?.playerToken]);

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error}</Text>
        <Pressable style={styles.secondaryBtn} onPress={() => navigation.replace('Home')}>
          <Text style={styles.secondaryBtnText}>Back to home</Text>
        </Pressable>
      </View>
    );
  }
  if (!pool) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.gold} />
      </View>
    );
  }

  const isHost = !!creds?.hostToken;
  const myPlayerId = creds?.playerId ?? '';
  const writeToken = creds?.hostToken || creds?.playerToken || '';

  const onCellTap = async (idx: number) => {
    if (!writeToken) return;
    if (pool.state.revealed) {
      Alert.alert('Locked', 'Numbers have been revealed; the board is locked.');
      return;
    }
    setBusyIdx(idx);
    try {
      const owner = pool.state.assignments[idx];
      let updated: Pool;
      if (owner === '') {
        updated = await claimSquare(poolId, idx, writeToken);
      } else if (owner === myPlayerId || isHost) {
        updated = await unclaimSquare(poolId, idx, writeToken);
      } else {
        const ownerName = pool.state.players.find((p) => p.id === owner)?.name ?? 'someone';
        Alert.alert('Already claimed', `That square belongs to ${ownerName}.`);
        return;
      }
      storeRef.current?.setPool(updated);
    } catch (e) {
      Alert.alert('Could not update square', (e as Error).message);
    } finally {
      setBusyIdx(null);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <PoolHeader pool={pool} isHost={isHost} myPlayerId={myPlayerId} />
      <LiveCard pool={pool} myPlayerId={myPlayerId} />
      <PlayersStrip players={pool.state.players} myPlayerId={myPlayerId} />
      <Board pool={pool} myPlayerId={myPlayerId} busyIdx={busyIdx} onCellTap={onCellTap} />
      {isHost && <HostControls pool={pool} hostToken={creds!.hostToken!} />}
      {Object.keys(pool.state.winners).length > 0 && <WinnersPanel pool={pool} />}
      <BubbleHistoryPanel pool={pool} myPlayerId={myPlayerId} />
      <BiggestLosersPanel pool={pool} />
    </ScrollView>
  );
}

// --- Header ---

function PoolHeader({ pool, isHost, myPlayerId }: { pool: Pool; isHost: boolean; myPlayerId: string }) {
  const me = pool.state.players.find((p) => p.id === myPlayerId);
  const onCopy = async () => {
    await Clipboard.setStringAsync(pool.id);
  };
  return (
    <View style={styles.headerPanel}>
      <View style={{ flex: 1 }}>
        <Text style={styles.headerLabel}>{isHost ? 'You are the host' : 'Player'}</Text>
        <Text style={styles.headerName}>{me?.name ?? 'Anonymous'}</Text>
      </View>
      <Pressable onPress={onCopy} style={styles.codeBtn}>
        <Text style={styles.codeLabel}>Pool code</Text>
        <Text style={styles.codeValue}>{pool.id}</Text>
        <Text style={styles.codeHint}>tap to copy</Text>
      </Pressable>
    </View>
  );
}

// --- Live card ---

function LiveCard({ pool, myPlayerId }: { pool: Pool; myPlayerId: string }) {
  const live = pool.state.live;
  const game = pool.state.game;
  const bubble = useMemo(() => computeBubble(pool.state), [pool]);
  const bubblePlayer = bubble?.playerId
    ? pool.state.players.find((p) => p.id === bubble.playerId)
    : null;

  const dotColor =
    !live ? theme.muted :
    live.state === 'in' ? theme.hit :
    live.state === 'pre' ? theme.gold :
    theme.muted;

  return (
    <View style={styles.panel}>
      <View style={styles.liveTop}>
        <View style={[styles.liveDot, { backgroundColor: dotColor }]} />
        <Text style={styles.liveStatus}>
          {!live
            ? 'No live data yet'
            : live.state === 'pre'
              ? `Tipoff: ${live.detail}`
              : live.state === 'post'
                ? `FINAL · ${live.detail}`
                : `LIVE · ${live.detail}`}
        </Text>
      </View>
      <View style={styles.scoreRow}>
        <View style={styles.scoreCard}>
          <Text style={styles.scoreLabel}>{game?.awayAbbrev || 'Away'}</Text>
          <Text style={styles.scoreVal}>{live?.away ?? '--'}</Text>
        </View>
        <View style={styles.scoreCard}>
          <Text style={styles.scoreLabel}>{game?.homeAbbrev || 'Home'}</Text>
          <Text style={styles.scoreVal}>{live?.home ?? '--'}</Text>
        </View>
      </View>
      <View style={[styles.bubbleCard, bubblePlayer?.id === myPlayerId && styles.bubbleSelfCard]}>
        <Text style={styles.bubbleLabel}>On the bubble</Text>
        {bubble && bubblePlayer ? (
          <>
            <Text style={[styles.bubbleName, { color: bubblePlayer.color }]}>{bubblePlayer.name}</Text>
            <Text style={styles.bubbleSub}>
              {(game?.awayAbbrev || 'A')} {live?.away} · {(game?.homeAbbrev || 'H')} {live?.home}
            </Text>
          </>
        ) : bubble ? (
          <>
            <Text style={styles.bubbleName}>(unclaimed)</Text>
            <Text style={styles.bubbleSub}>
              square row {bubble.row} col {bubble.col}
            </Text>
          </>
        ) : (
          <Text style={styles.bubbleSub}>Waiting for tip-off…</Text>
        )}
      </View>
    </View>
  );
}

// --- Players strip ---

function PlayersStrip({ players, myPlayerId }: { players: Player[]; myPlayerId: string }) {
  if (players.length === 0) return null;
  return (
    <View style={styles.panel}>
      <Text style={styles.label}>{players.length} {players.length === 1 ? 'player' : 'players'}</Text>
      <View style={styles.playersRow}>
        {players.map((p) => (
          <View key={p.id} style={[styles.playerChip, { borderColor: p.color }]}>
            <View style={[styles.playerDot, { backgroundColor: p.color }]} />
            <Text style={styles.playerName}>
              {p.name}
              {p.id === myPlayerId ? ' (you)' : ''}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

// --- Board ---

function Board({
  pool,
  myPlayerId,
  busyIdx,
  onCellTap,
}: {
  pool: Pool;
  myPlayerId: string;
  busyIdx: number | null;
  onCellTap: (idx: number) => void;
}) {
  const state = pool.state;
  const playersById = useMemo(() => {
    const m: Record<string, Player> = {};
    for (const p of state.players) m[p.id] = p;
    return m;
  }, [state.players]);

  const winnerCells = useMemo(() => {
    const m: Record<number, string[]> = {};
    for (const [q, w] of Object.entries(state.winners)) {
      const idx = w.row * 10 + w.col;
      (m[idx] ||= []).push(QUARTER_LABELS[q] ?? q);
    }
    return m;
  }, [state.winners]);

  const bubble = useMemo(() => computeBubble(state), [state]);
  const bubbleIdx = bubble ? bubble.row * 10 + bubble.col : -1;

  const game = state.game;
  return (
    <View style={styles.panel}>
      <View style={styles.boardTopRow}>
        <Text style={styles.boardAxisLabel}>← {game?.awayAbbrev || 'AWAY'} →</Text>
      </View>
      <View style={styles.boardRowDigits}>
        <View style={styles.cornerCell} />
        {Array.from({ length: 10 }, (_, c) => (
          <View key={c} style={styles.headerCell}>
            <Text style={styles.headerCellText}>
              {state.revealed && state.colDigits ? state.colDigits[c] : '?'}
            </Text>
          </View>
        ))}
      </View>
      {Array.from({ length: 10 }, (_, r) => (
        <View key={r} style={styles.boardRow}>
          <View style={styles.headerCell}>
            <Text style={styles.headerCellText}>
              {state.revealed && state.rowDigits ? state.rowDigits[r] : '?'}
            </Text>
          </View>
          {Array.from({ length: 10 }, (_, c) => {
            const idx = r * 10 + c;
            const ownerId = state.assignments[idx] ?? '';
            const owner = ownerId ? playersById[ownerId] : null;
            const isMine = ownerId === myPlayerId && ownerId !== '';
            const winLabels = winnerCells[idx] ?? [];
            const isBubble = idx === bubbleIdx;
            const cellBg = owner ? owner.color + '40' : 'transparent';
            const cellBorder = owner ? owner.color : theme.line;
            return (
              <Pressable
                key={c}
                style={[
                  styles.cell,
                  { backgroundColor: cellBg, borderColor: cellBorder },
                  isMine && styles.cellMine,
                  winLabels.length > 0 && styles.cellWinner,
                  isBubble && styles.cellBubble,
                  busyIdx === idx && styles.cellBusy,
                ]}
                onPress={() => onCellTap(idx)}
              >
                {owner ? (
                  <Text style={styles.cellInitial} numberOfLines={1}>
                    {initials(owner.name)}
                  </Text>
                ) : (
                  <Text style={styles.cellPlus}>+</Text>
                )}
                {winLabels.length > 0 && <Text style={styles.cellWinBadge}>★</Text>}
                {isBubble && winLabels.length === 0 && <Text style={styles.cellBubbleBadge}>•</Text>}
              </Pressable>
            );
          })}
        </View>
      ))}
      <Text style={styles.boardHint}>
        Rows = {game?.homeAbbrev || 'home'} last digit · cols = {game?.awayAbbrev || 'away'} last digit
        {state.revealed ? '' : ' · numbers hidden until host reveals'}
      </Text>
    </View>
  );
}

// --- Host controls ---

function HostControls({ pool, hostToken }: { pool: Pool; hostToken: string }) {
  const [busy, setBusy] = useState(false);
  const [winnerHome, setWinnerHome] = useState('');
  const [winnerAway, setWinnerAway] = useState('');
  const [winnerQuarter, setWinnerQuarter] = useState<'q1' | 'q2' | 'q3' | 'final'>('q1');
  const [interval, setIntervalState] = useState<number>(pool.state.bubbleIntervalSec);

  const reveal = async () => {
    setBusy(true);
    try {
      await patchPool(pool.id, hostToken, { revealed: true });
    } catch (e) {
      Alert.alert('Could not reveal', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const recordWinner = async () => {
    const home = parseInt(winnerHome, 10);
    const away = parseInt(winnerAway, 10);
    if (Number.isNaN(home) || Number.isNaN(away)) {
      Alert.alert('Enter both scores first.');
      return;
    }
    if (!pool.state.rowDigits || !pool.state.colDigits) {
      Alert.alert('Reveal numbers before recording winners.');
      return;
    }
    const row = pool.state.rowDigits.indexOf(Math.abs(home) % 10);
    const col = pool.state.colDigits.indexOf(Math.abs(away) % 10);
    if (row < 0 || col < 0) {
      Alert.alert('Could not match scores to a square.');
      return;
    }
    const playerId = pool.state.assignments[row * 10 + col] || undefined;
    setBusy(true);
    try {
      const newWinners = { ...pool.state.winners, [winnerQuarter]: { home, away, row, col, playerId } };
      await patchPool(pool.id, hostToken, { winners: newWinners });
      setWinnerHome('');
      setWinnerAway('');
    } catch (e) {
      Alert.alert('Could not record winner', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveInterval = async () => {
    setBusy(true);
    try {
      await patchPool(pool.id, hostToken, { bubbleIntervalSec: interval });
    } catch (e) {
      Alert.alert('Could not update interval', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.panel}>
      <Text style={styles.label}>Host controls</Text>
      <Pressable
        style={[styles.primaryBtn, (busy || pool.state.revealed) && styles.btnDisabled]}
        disabled={busy || pool.state.revealed}
        onPress={reveal}
      >
        <Text style={styles.primaryBtnText}>
          {pool.state.revealed ? 'Numbers revealed' : 'Reveal numbers'}
        </Text>
      </Pressable>

      <Text style={[styles.label, { marginTop: 10 }]}>Bubble snapshot interval</Text>
      <View style={styles.intervalRow}>
        {[
          { label: '30s', value: 30 },
          { label: '1 min', value: 60 },
          { label: '3 min', value: 180 },
          { label: '10 min', value: 600 },
        ].map((p) => (
          <Pressable
            key={p.value}
            style={[styles.intervalBtn, interval === p.value && styles.intervalBtnActive]}
            onPress={() => setIntervalState(p.value)}
          >
            <Text style={[styles.intervalText, interval === p.value && styles.intervalTextActive]}>
              {p.label}
            </Text>
          </Pressable>
        ))}
      </View>
      <Pressable
        style={[styles.secondaryBtn, busy && styles.btnDisabled]}
        disabled={busy || interval === pool.state.bubbleIntervalSec}
        onPress={saveInterval}
      >
        <Text style={styles.secondaryBtnText}>Save interval</Text>
      </Pressable>

      {pool.state.revealed && (
        <>
          <Text style={[styles.label, { marginTop: 10 }]}>Record quarter winner</Text>
          <View style={styles.row}>
            <TextInput
              style={[styles.input, { flex: 1 }]}
              placeholder={`${pool.state.game?.awayAbbrev || 'Away'} score`}
              placeholderTextColor={theme.muted}
              keyboardType="number-pad"
              value={winnerAway}
              onChangeText={setWinnerAway}
            />
            <TextInput
              style={[styles.input, { flex: 1 }]}
              placeholder={`${pool.state.game?.homeAbbrev || 'Home'} score`}
              placeholderTextColor={theme.muted}
              keyboardType="number-pad"
              value={winnerHome}
              onChangeText={setWinnerHome}
            />
          </View>
          <View style={styles.intervalRow}>
            {(['q1', 'q2', 'q3', 'final'] as const).map((q) => (
              <Pressable
                key={q}
                style={[styles.intervalBtn, winnerQuarter === q && styles.intervalBtnActive]}
                onPress={() => setWinnerQuarter(q)}
              >
                <Text style={[styles.intervalText, winnerQuarter === q && styles.intervalTextActive]}>
                  {QUARTER_LABELS[q]}
                </Text>
              </Pressable>
            ))}
          </View>
          <Pressable
            style={[styles.primaryBtn, busy && styles.btnDisabled]}
            disabled={busy}
            onPress={recordWinner}
          >
            <Text style={styles.primaryBtnText}>Record winner</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

// --- Winners list ---

function WinnersPanel({ pool }: { pool: Pool }) {
  const state = pool.state;
  const order: Array<'q1' | 'q2' | 'q3' | 'final'> = ['q1', 'q2', 'q3', 'final'];
  return (
    <View style={styles.panel}>
      <Text style={styles.label}>Quarter winners</Text>
      {order.map((q) => {
        const w = state.winners[q];
        if (!w) return null;
        const player = w.playerId ? state.players.find((p) => p.id === w.playerId) : null;
        return (
          <View key={q} style={styles.winnerRow}>
            <Text style={styles.winnerQ}>{QUARTER_LABELS[q]}</Text>
            <Text style={[styles.winnerName, { color: player?.color || theme.text }]}>
              {player?.name || 'unclaimed'}
            </Text>
            <Text style={styles.winnerScore}>
              {(state.game?.awayAbbrev || 'A')} {w.away} · {(state.game?.homeAbbrev || 'H')} {w.home}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

// --- Bubble history ---

function BubbleHistoryPanel({ pool, myPlayerId }: { pool: Pool; myPlayerId: string }) {
  const history = pool.state.bubbleHistory;
  if (history.length === 0) {
    return (
      <View style={styles.panel}>
        <Text style={styles.label}>Bubble history</Text>
        <Text style={styles.muted}>No bubble snapshots yet — game hasn't started.</Text>
      </View>
    );
  }
  // Most recent first.
  const ordered = [...history].reverse();
  const playersById = Object.fromEntries(pool.state.players.map((p) => [p.id, p]));
  return (
    <View style={styles.panel}>
      <Text style={styles.label}>Bubble history ({history.length})</Text>
      {ordered.slice(0, 50).map((entry, i) => {
        const player = entry.playerId ? playersById[entry.playerId] : null;
        const isYou = entry.playerId && entry.playerId === myPlayerId;
        return (
          <View key={`${entry.ts}-${i}`} style={styles.historyRow}>
            <Text style={styles.historyDetail}>{entry.detail || '—'}</Text>
            <Text style={[styles.historyName, player ? { color: player.color } : null]}>
              {player ? player.name + (isYou ? ' (you)' : '') : 'unclaimed'}
            </Text>
            <Text style={styles.historyScore}>
              {(pool.state.game?.awayAbbrev || 'A')} {entry.away} · {(pool.state.game?.homeAbbrev || 'H')} {entry.home}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

// --- Biggest losers leaderboard ---

function BiggestLosersPanel({ pool }: { pool: Pool }) {
  const counts: Record<string, number> = {};
  for (const e of pool.state.bubbleHistory) {
    if (!e.playerId) continue;
    counts[e.playerId] = (counts[e.playerId] ?? 0) + 1;
  }
  const ranked = pool.state.players
    .map((p) => ({ player: p, count: counts[p.id] ?? 0 }))
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count);

  if (ranked.length === 0) return null;

  return (
    <View style={styles.panel}>
      <Text style={styles.label}>Biggest losers</Text>
      <Text style={styles.helper}>Times each player was on the bubble at snapshot.</Text>
      {ranked.map((row, i) => (
        <View key={row.player.id} style={styles.leaderRow}>
          <Text style={styles.leaderRank}>#{i + 1}</Text>
          <Text style={[styles.leaderName, { color: row.player.color }]}>{row.player.name}</Text>
          <Text style={styles.leaderCount}>{row.count}×</Text>
        </View>
      ))}
    </View>
  );
}

// --- Helpers ---

function computeBubble(state: PoolState): BubbleEntry | null {
  if (!state.live || state.live.state === 'pre') return null;
  if (!state.rowDigits || !state.colDigits) return null;
  if (state.rowDigits.length !== 10 || state.colDigits.length !== 10) return null;
  const hDigit = Math.abs(state.live.home) % 10;
  const aDigit = Math.abs(state.live.away) % 10;
  const row = state.rowDigits.indexOf(hDigit);
  const col = state.colDigits.indexOf(aDigit);
  if (row < 0 || col < 0) return null;
  const playerId = state.assignments[row * 10 + col] || undefined;
  return {
    ts: state.live.fetchedAt,
    home: state.live.home,
    away: state.live.away,
    detail: state.live.detail,
    row,
    col,
    playerId,
  };
}

function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

const CELL = 30;

const styles = StyleSheet.create({
  wrap: { padding: 12, gap: 12 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16, gap: 12 },
  errorText: { color: theme.hit, fontSize: 14 },
  panel: {
    backgroundColor: theme.panel,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.line,
    padding: 12,
    gap: 8,
  },
  label: { color: theme.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 },
  helper: { color: theme.muted, fontSize: 12, lineHeight: 16 },
  muted: { color: theme.muted, fontSize: 13 },
  row: { flexDirection: 'row', gap: 8 },

  headerPanel: {
    backgroundColor: theme.panel,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.line,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  headerLabel: { color: theme.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 },
  headerName: { color: theme.text, fontSize: 18, fontWeight: '700' },
  codeBtn: {
    backgroundColor: theme.panelAlt,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    alignItems: 'center',
  },
  codeLabel: { color: theme.muted, fontSize: 10, textTransform: 'uppercase', letterSpacing: 1 },
  codeValue: { color: theme.text, fontSize: 16, fontWeight: '700', fontFamily: 'Menlo' },
  codeHint: { color: theme.muted, fontSize: 10 },

  liveTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  liveDot: { width: 10, height: 10, borderRadius: 5 },
  liveStatus: { color: theme.text, fontWeight: '700' },
  scoreRow: { flexDirection: 'row', gap: 8 },
  scoreCard: {
    flex: 1,
    backgroundColor: theme.panelAlt,
    borderRadius: 8,
    padding: 10,
  },
  scoreLabel: { color: theme.muted, fontSize: 11, textTransform: 'uppercase' },
  scoreVal: { color: theme.text, fontSize: 28, fontWeight: '800' },
  bubbleCard: {
    backgroundColor: '#0d2227',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(0,229,255,0.45)',
    padding: 10,
  },
  bubbleSelfCard: { borderColor: theme.gold, backgroundColor: '#221b08' },
  bubbleLabel: { color: '#7ee9f5', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 },
  bubbleName: { color: theme.text, fontSize: 22, fontWeight: '800', marginTop: 2 },
  bubbleSub: { color: theme.muted, fontSize: 12 },

  playersRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  playerChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    backgroundColor: theme.panelAlt,
  },
  playerDot: { width: 8, height: 8, borderRadius: 4 },
  playerName: { color: theme.text, fontSize: 12, fontWeight: '600' },

  boardTopRow: { alignItems: 'center', marginBottom: 4 },
  boardAxisLabel: { color: theme.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 },
  boardRowDigits: { flexDirection: 'row' },
  boardRow: { flexDirection: 'row' },
  cornerCell: { width: CELL, height: CELL },
  headerCell: {
    width: CELL,
    height: CELL,
    backgroundColor: '#20242d',
    borderColor: theme.line,
    borderWidth: 0.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerCellText: { color: theme.text, fontSize: 12, fontWeight: '700' },
  cell: {
    width: CELL,
    height: CELL,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  cellMine: { borderWidth: 2 },
  cellWinner: { borderColor: theme.gold, borderWidth: 2 },
  cellBubble: { borderColor: theme.accent, borderWidth: 2 },
  cellBusy: { opacity: 0.4 },
  cellInitial: { color: theme.text, fontWeight: '700', fontSize: 10 },
  cellPlus: { color: theme.muted, fontSize: 14 },
  cellWinBadge: { position: 'absolute', top: -1, right: 1, color: theme.gold, fontSize: 8 },
  cellBubbleBadge: { position: 'absolute', top: -1, right: 1, color: theme.accent, fontSize: 14 },
  boardHint: { color: theme.muted, fontSize: 11, marginTop: 4 },

  primaryBtn: {
    backgroundColor: theme.gold,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  primaryBtnText: { color: '#111', fontWeight: '700', fontSize: 14 },
  secondaryBtn: {
    backgroundColor: theme.line,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  secondaryBtnText: { color: theme.text, fontWeight: '700' },
  btnDisabled: { opacity: 0.45 },
  intervalRow: { flexDirection: 'row', gap: 6 },
  intervalBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.line,
    backgroundColor: theme.panelAlt,
    alignItems: 'center',
  },
  intervalBtnActive: { borderColor: theme.gold, backgroundColor: '#1d1a09' },
  intervalText: { color: theme.muted, fontWeight: '700', fontSize: 12 },
  intervalTextActive: { color: theme.gold },
  input: {
    backgroundColor: theme.panelAlt,
    borderColor: theme.line,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 10,
    color: theme.text,
    fontSize: 15,
  },

  winnerRow: {
    flexDirection: 'row',
    backgroundColor: theme.panelAlt,
    borderLeftWidth: 4,
    borderLeftColor: theme.gold,
    borderRadius: 6,
    padding: 8,
    gap: 8,
    alignItems: 'center',
  },
  winnerQ: { color: theme.gold, fontWeight: '700', minWidth: 60 },
  winnerName: { fontWeight: '700', flex: 1 },
  winnerScore: { color: theme.muted, fontSize: 12 },

  historyRow: {
    flexDirection: 'row',
    backgroundColor: theme.panelAlt,
    borderRadius: 6,
    padding: 8,
    gap: 8,
    alignItems: 'center',
  },
  historyDetail: { color: theme.muted, fontSize: 11, minWidth: 70 },
  historyName: { color: theme.text, fontWeight: '600', flex: 1 },
  historyScore: { color: theme.muted, fontSize: 11 },

  leaderRow: {
    flexDirection: 'row',
    backgroundColor: theme.panelAlt,
    borderRadius: 6,
    padding: 8,
    gap: 10,
    alignItems: 'center',
  },
  leaderRank: { color: theme.muted, fontWeight: '700', width: 30 },
  leaderName: { fontWeight: '700', flex: 1 },
  leaderCount: { color: theme.text, fontWeight: '700' },
});
