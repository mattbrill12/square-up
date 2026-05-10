import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import * as Clipboard from 'expo-clipboard';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { RootStackParamList } from '../../App';
import {
  getPool,
  isLocalApiUrl,
  joinPool,
  mockLive,
  patchPool,
  removePlayer,
  renamePlayer,
  setPushToken as apiSetPushToken,
  snapshotNow,
} from '../api';
import { notify } from '../notify';
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

type TabKey = 'live' | 'board' | 'history' | 'host';

export default function PoolScreen({ navigation, route }: Props) {
  const { poolId } = route.params;
  const [pool, setPool] = useState<Pool | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creds, setCreds] = useState<PoolCreds | null>(null);
  const [tab, setTab] = useState<TabKey | null>(null);
  const [lastSeenHistory, setLastSeenHistory] = useState<number | null>(null);
  const [focusedPlayerId, setFocusedPlayerId] = useState<string | null>(null);
  const storeRef = useRef<PoolStore | null>(null);

  // Load + connect WS once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const c = await loadCreds(poolId);
        if (!c?.playerToken && !c?.hostToken && !c?.observer) {
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

  // Track new bubble history while the user isn't on the History tab.
  // Defensive against pool being null on the first render.
  const peekActiveTab: TabKey = tab ?? (pool?.state.revealed ? 'live' : 'board');
  const bubbleHistoryLen = pool?.state.bubbleHistory.length ?? 0;
  useEffect(() => {
    if (!pool) return;
    if (lastSeenHistory === null) {
      setLastSeenHistory(bubbleHistoryLen);
      return;
    }
    if (peekActiveTab === 'history') {
      setLastSeenHistory(bubbleHistoryLen);
    }
  }, [peekActiveTab, bubbleHistoryLen, lastSeenHistory, pool]);

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
  const isObserver = !!creds?.observer && !creds?.playerId;
  const myPlayerId = creds?.playerId ?? '';
  const activeTab: TabKey = tab ?? (pool.state.revealed ? 'live' : 'board');
  const showHostTab = isHost;
  const newHistoryCount = Math.max(
    0,
    pool.state.bubbleHistory.length - (lastSeenHistory ?? pool.state.bubbleHistory.length),
  );

  const myAssignmentCount = pool.state.assignments.filter((a) => a === myPlayerId).length;

  return (
    <SafeAreaView style={styles.shell} edges={['top']}>
      <PoolHeader pool={pool} isHost={isHost} isObserver={isObserver} myPlayerId={myPlayerId} />
      <ScrollView
        contentContainerStyle={styles.tabBody}
        showsVerticalScrollIndicator={false}
      >
        {activeTab === 'live' && (
          <>
            <LiveCard pool={pool} myPlayerId={myPlayerId} />
            {isHost && pool.state.revealed && (
              <SnapshotButton pool={pool} hostToken={creds!.hostToken!} />
            )}
            <PlayersStrip players={pool.state.players} myPlayerId={myPlayerId} />
            {!isObserver && (
              <YourStatusCard
                pool={pool}
                myPlayerId={myPlayerId}
                count={myAssignmentCount}
                onGoToBoard={() => setTab('board')}
              />
            )}
            <RecentBubblesPanel
              pool={pool}
              myPlayerId={myPlayerId}
              onSeeAll={() => setTab('history')}
            />
          </>
        )}
        {activeTab === 'board' && (
          <>
            <PlayersStrip
              players={pool.state.players}
              myPlayerId={myPlayerId}
              focusedId={focusedPlayerId}
              onSelect={(id) => setFocusedPlayerId(id)}
            />
            <Board
              pool={pool}
              myPlayerId={myPlayerId}
              focusedPlayerId={focusedPlayerId}
            />
            {focusedPlayerId && pool.state.revealed && (
              <FocusedDigitsPanel pool={pool} focusedPlayerId={focusedPlayerId} />
            )}
          </>
        )}
        {activeTab === 'history' && (
          <>
            {Object.keys(pool.state.winners).length > 0 && <WinnersPanel pool={pool} />}
            <BubbleHistoryPanel pool={pool} myPlayerId={myPlayerId} />
            <BiggestLosersPanel pool={pool} />
          </>
        )}
        {activeTab === 'host' && isHost && (
          <>
            <HostControls pool={pool} hostToken={creds!.hostToken!} />
            {isLocalApiUrl() && <MockPanel pool={pool} hostToken={creds!.hostToken!} />}
          </>
        )}
      </ScrollView>
      <TabBar
        active={activeTab}
        onChange={setTab}
        showHost={showHostTab}
        bubbleCount={newHistoryCount}
      />
    </SafeAreaView>
  );
}

// --- Tab bar ---

const TAB_ICONS: Record<TabKey, keyof typeof Ionicons.glyphMap> = {
  live: 'pulse-outline',
  board: 'grid-outline',
  history: 'time-outline',
  host: 'settings-outline',
};

function TabBar({
  active,
  onChange,
  showHost,
  bubbleCount,
}: {
  active: TabKey;
  onChange: (k: TabKey) => void;
  showHost: boolean;
  bubbleCount: number;
}) {
  const tabs: Array<{ key: TabKey; label: string; badge?: string }> = [
    { key: 'live', label: 'Live' },
    { key: 'board', label: 'Board' },
    { key: 'history', label: 'History', badge: bubbleCount > 0 ? String(bubbleCount) : undefined },
  ];
  if (showHost) tabs.push({ key: 'host', label: 'Host' });
  return (
    <View style={styles.tabBar}>
      {tabs.map((t) => {
        const isActive = active === t.key;
        const color = isActive ? theme.gold : theme.muted;
        return (
          <Pressable
            key={t.key}
            style={[styles.tabBtn, isActive && styles.tabBtnActive]}
            onPress={() => onChange(t.key)}
          >
            <View style={styles.tabIconWrap}>
              <Ionicons name={TAB_ICONS[t.key]} size={22} color={color} />
              {t.badge && (
                <View style={styles.tabBadgeFloat}>
                  <Text style={styles.tabBadgeText}>{t.badge}</Text>
                </View>
              )}
            </View>
            <Text style={[styles.tabLabel, isActive && styles.tabLabelActive]}>{t.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// --- Live-tab helpers ---

function YourStatusCard({
  pool,
  myPlayerId,
  count,
  onGoToBoard,
}: {
  pool: Pool;
  myPlayerId: string;
  count: number;
  onGoToBoard: () => void;
}) {
  const me = pool.state.players.find((p) => p.id === myPlayerId);
  const total = pool.state.assignments.filter((a) => a !== '').length;
  return (
    <Pressable style={styles.panel} onPress={onGoToBoard}>
      <Text style={styles.label}>Your squares</Text>
      <View style={styles.row}>
        <View style={[styles.playerDot, { backgroundColor: me?.color || theme.muted, width: 14, height: 14, borderRadius: 7 }]} />
        <Text style={{ color: theme.text, fontSize: 18, fontWeight: '700' }}>
          {count} of 100
        </Text>
        <Text style={{ color: theme.muted, fontSize: 12 }}>· {total} total claimed</Text>
      </View>
      <Text style={styles.helper}>Tap to open the board.</Text>
    </Pressable>
  );
}

function RecentBubblesPanel({
  pool,
  myPlayerId,
  onSeeAll,
}: {
  pool: Pool;
  myPlayerId: string;
  onSeeAll: () => void;
}) {
  const recent = [...pool.state.bubbleHistory].reverse().slice(0, 5);
  if (recent.length === 0) {
    return (
      <View style={styles.panel}>
        <Text style={styles.label}>Recent bubble</Text>
        <Text style={styles.muted}>No snapshots yet.</Text>
      </View>
    );
  }
  const playersById = Object.fromEntries(pool.state.players.map((p) => [p.id, p]));
  return (
    <View style={styles.panel}>
      <View style={[styles.row, { justifyContent: 'space-between' }]}>
        <Text style={styles.label}>Recent bubble ({pool.state.bubbleHistory.length})</Text>
        <Pressable onPress={onSeeAll}>
          <Text style={[styles.helper, { color: theme.accent }]}>see all →</Text>
        </Pressable>
      </View>
      {recent.map((entry, i) => {
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

// --- Mock controls (dev only) ---

function MockPanel({ pool, hostToken }: { pool: Pool; hostToken: string }) {
  const live = pool.state.live;
  const [state, setMockState] = useState<'pre' | 'in' | 'post'>(
    (live?.state as 'pre' | 'in' | 'post') ?? 'in',
  );
  const [home, setHome] = useState(String(live?.home ?? 0));
  const [away, setAway] = useState(String(live?.away ?? 0));
  const [detail, setDetail] = useState(live?.detail ?? 'Q1 10:00');
  const [busy, setBusy] = useState(false);

  const apply = async (sample: boolean) => {
    setBusy(true);
    try {
      await mockLive(pool.id, hostToken, {
        state,
        home: parseInt(home, 10) || 0,
        away: parseInt(away, 10) || 0,
        detail,
        sample,
      });
    } catch (e) {
      notify('Mock failed', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const preset = (s: 'pre' | 'in' | 'post', h: number, a: number, d: string) => {
    setMockState(s);
    setHome(String(h));
    setAway(String(a));
    setDetail(d);
  };

  const nudge = () => {
    setHome(String((parseInt(home, 10) || 0) + 1 + Math.floor(Math.random() * 3)));
    setAway(String((parseInt(away, 10) || 0) + 1 + Math.floor(Math.random() * 3)));
  };

  return (
    <View style={[styles.panel, { borderColor: theme.accent }]}>
      <Text style={[styles.label, { color: theme.accent }]}>Dev — mock live game</Text>
      <Text style={styles.helper}>
        Only visible against a local backend. Pushes a fake live state to test the bubble + history.
      </Text>

      <View style={styles.intervalRow}>
        {(['pre', 'in', 'post'] as const).map((s) => (
          <Pressable
            key={s}
            style={[styles.intervalBtn, state === s && styles.intervalBtnActive]}
            onPress={() => setMockState(s)}
          >
            <Text style={[styles.intervalText, state === s && styles.intervalTextActive]}>
              {s.toUpperCase()}
            </Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.row}>
        <TextInput
          style={[styles.input, { flex: 1 }]}
          placeholder={`${pool.state.game?.awayAbbrev || 'Away'} score`}
          placeholderTextColor={theme.muted}
          keyboardType="number-pad"
          value={away}
          onChangeText={setAway}
        />
        <TextInput
          style={[styles.input, { flex: 1 }]}
          placeholder={`${pool.state.game?.homeAbbrev || 'Home'} score`}
          placeholderTextColor={theme.muted}
          keyboardType="number-pad"
          value={home}
          onChangeText={setHome}
        />
      </View>
      <TextInput
        style={styles.input}
        placeholder='Detail e.g. "Q3 5:22"'
        placeholderTextColor={theme.muted}
        value={detail}
        onChangeText={setDetail}
      />

      <View style={styles.row}>
        <Pressable
          style={[styles.secondaryBtn, { flex: 1 }, busy && styles.btnDisabled]}
          disabled={busy}
          onPress={() => apply(false)}
        >
          <Text style={styles.secondaryBtnText}>{busy ? '…' : 'Apply'}</Text>
        </Pressable>
        <Pressable
          style={[styles.primaryBtn, { flex: 1 }, busy && styles.btnDisabled]}
          disabled={busy}
          onPress={() => apply(true)}
        >
          <Text style={styles.primaryBtnText}>{busy ? '…' : 'Apply + sample'}</Text>
        </Pressable>
      </View>

      <Pressable style={styles.secondaryBtn} onPress={nudge}>
        <Text style={styles.secondaryBtnText}>Random nudge (+1–3 each)</Text>
      </Pressable>

      <View style={styles.row}>
        <Pressable
          style={[styles.intervalBtn, { flex: 1 }]}
          onPress={() => preset('pre', 0, 0, 'Pregame')}
        >
          <Text style={styles.intervalText}>Tipoff</Text>
        </Pressable>
        <Pressable
          style={[styles.intervalBtn, { flex: 1 }]}
          onPress={() => preset('in', 24, 21, 'End of 1st')}
        >
          <Text style={styles.intervalText}>End Q1</Text>
        </Pressable>
        <Pressable
          style={[styles.intervalBtn, { flex: 1 }]}
          onPress={() => preset('in', 53, 49, 'Halftime')}
        >
          <Text style={styles.intervalText}>Half</Text>
        </Pressable>
      </View>
      <View style={styles.row}>
        <Pressable
          style={[styles.intervalBtn, { flex: 1 }]}
          onPress={() => preset('in', 81, 76, 'End of 3rd')}
        >
          <Text style={styles.intervalText}>End Q3</Text>
        </Pressable>
        <Pressable
          style={[styles.intervalBtn, { flex: 1 }]}
          onPress={() => preset('post', 108, 102, 'Final')}
        >
          <Text style={styles.intervalText}>Final</Text>
        </Pressable>
      </View>
    </View>
  );
}

// --- Header ---

function FocusedDigitsPanel({
  pool,
  focusedPlayerId,
}: {
  pool: Pool;
  focusedPlayerId: string;
}) {
  const player = pool.state.players.find((p) => p.id === focusedPlayerId);
  if (!player) return null;
  const rowDigits = pool.state.rowDigits;
  const colDigits = pool.state.colDigits;
  if (!rowDigits || !colDigits || rowDigits.length !== 10 || colDigits.length !== 10) {
    return null;
  }
  const cells: Array<{ home: number; away: number; isWinner: boolean }> = [];
  const winners = pool.state.winners;
  for (let i = 0; i < pool.state.assignments.length; i++) {
    if (pool.state.assignments[i] === focusedPlayerId) {
      const r = Math.floor(i / 10);
      const c = i % 10;
      const isWinner = Object.values(winners).some((w) => w.row === r && w.col === c);
      cells.push({ home: rowDigits[r], away: colDigits[c], isWinner });
    }
  }
  cells.sort((a, b) => a.home - b.home || a.away - b.away);
  if (cells.length === 0) return null;

  const home = pool.state.game?.homeAbbrev || 'home';
  const away = pool.state.game?.awayAbbrev || 'away';
  return (
    <View style={[styles.panel, { borderColor: player.color }]}>
      <View style={styles.labelRow}>
        <View style={[styles.playerDot, { backgroundColor: player.color }]} />
        <Text style={styles.label}>
          {player.name}'s winning digits ({cells.length})
        </Text>
      </View>
      <Text style={styles.helper}>
        Wins when {home} ends in the first number AND {away} ends in the second.
      </Text>
      <View style={styles.digitsGrid}>
        {cells.map((c, i) => (
          <View
            key={`${c.home}-${c.away}-${i}`}
            style={[styles.digitChip, c.isWinner && styles.digitChipWinner]}
          >
            <Text
              style={[
                styles.digitChipText,
                { color: c.isWinner ? theme.gold : theme.text },
              ]}
            >
              {home} {c.home} · {away} {c.away}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function PoolHeader({
  pool,
  isHost,
  isObserver,
  myPlayerId,
}: {
  pool: Pool;
  isHost: boolean;
  isObserver: boolean;
  myPlayerId: string;
}) {
  const navigation = useNavigation();
  const me = pool.state.players.find((p) => p.id === myPlayerId);
  const [copied, setCopied] = useState(false);

  const shareUrl =
    typeof window !== 'undefined' && window.location?.origin
      ? `${window.location.origin}/p/${pool.id}`
      : pool.id;

  const onCopy = async () => {
    await Clipboard.setStringAsync(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const goBack = () => {
    if (navigation.canGoBack()) {
      navigation.goBack();
    } else {
      (navigation as { navigate: (n: string) => void }).navigate('Home');
    }
  };

  return (
    <View style={styles.headerPanel}>
      <Pressable onPress={goBack} hitSlop={10} style={styles.headerBack}>
        <Ionicons name="chevron-back" size={22} color={theme.text} />
      </Pressable>
      <View style={{ flex: 1 }}>
        <Text style={styles.headerLabel}>
          {isHost ? 'Host' : isObserver ? 'Observer' : 'Player'}
        </Text>
        <Text style={styles.headerName} numberOfLines={1}>
          {isObserver ? 'Watching' : me?.name ?? 'Anonymous'}
        </Text>
      </View>
      <Pressable onPress={onCopy} style={styles.codeBtn}>
        <Text style={styles.codeLabel}>Code</Text>
        <Text style={styles.codeValue}>{pool.id}</Text>
        <View style={styles.codeHintRow}>
          <Ionicons
            name={copied ? 'checkmark' : 'link-outline'}
            size={11}
            color={copied ? theme.gold : theme.muted}
          />
          <Text style={[styles.codeHint, copied && { color: theme.gold }]}>
            {copied ? 'copied!' : 'copy link'}
          </Text>
        </View>
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
        <View style={styles.labelRow}>
          <Ionicons name="radio-outline" size={14} color={theme.accent} />
          <Text style={styles.bubbleLabel}>On the bubble</Text>
        </View>
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

function PlayersStrip({
  players,
  myPlayerId,
  focusedId,
  onSelect,
}: {
  players: Player[];
  myPlayerId: string;
  focusedId?: string | null;
  onSelect?: (id: string | null) => void;
}) {
  if (players.length === 0) return null;
  const interactive = !!onSelect;
  return (
    <View style={styles.panel}>
      <View style={[styles.labelRow, { justifyContent: 'space-between' }]}>
        <Text style={styles.label}>
          {players.length} {players.length === 1 ? 'player' : 'players'}
          {interactive ? ' · tap to focus' : ''}
        </Text>
        {focusedId && onSelect && (
          <Pressable onPress={() => onSelect(null)} hitSlop={6}>
            <Text style={[styles.helper, { color: theme.accent, fontWeight: '700' }]}>
              show all
            </Text>
          </Pressable>
        )}
      </View>
      <View style={styles.playersRow}>
        {players.map((p) => {
          const isFocused = focusedId === p.id;
          const isDimmed = focusedId !== undefined && focusedId !== null && !isFocused;
          const chip = (
            <View
              style={[
                styles.playerChip,
                { borderColor: p.color },
                isFocused && { backgroundColor: p.color + '33' },
                isDimmed && { opacity: 0.35 },
              ]}
            >
              <View style={[styles.playerDot, { backgroundColor: p.color }]} />
              <Text style={styles.playerName}>
                {p.name}
                {p.id === myPlayerId ? ' (you)' : ''}
              </Text>
            </View>
          );
          if (!interactive) {
            return <View key={p.id}>{chip}</View>;
          }
          return (
            <Pressable
              key={p.id}
              onPress={() => onSelect!(isFocused ? null : p.id)}
            >
              {chip}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

// --- Board ---

function Board({
  pool,
  myPlayerId,
  focusedPlayerId,
}: {
  pool: Pool;
  myPlayerId: string;
  focusedPlayerId?: string | null;
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
  const homeAbbrev = game?.homeAbbrev || 'HOME';
  const awayAbbrev = game?.awayAbbrev || 'AWAY';
  const homeStack = [...homeAbbrev.split(''), '↓'];
  return (
    <View style={styles.panel}>
      {/* Top: away team label centered above the column digits. */}
      <View style={styles.boardTopAxis}>
        <View style={{ width: LEFT_AXIS }} />
        <View style={{ width: CELL }} />
        <View style={{ width: CELL * 10, alignItems: 'center' }}>
          <Text style={styles.boardLegendText}>{awayAbbrev} →</Text>
        </View>
      </View>

      <View style={styles.boardMain}>
        {/* Left: home team stacked vertically, character per line. */}
        <View style={styles.boardLeftAxis}>
          {homeStack.map((ch, i) => (
            <Text key={i} style={styles.boardLeftAxisLetter}>
              {ch}
            </Text>
          ))}
        </View>

        <View>
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
            const isFocusedOwner = focusedPlayerId && ownerId === focusedPlayerId;
            const isDimmed = !!focusedPlayerId && !isFocusedOwner;
            const cellBg = owner ? owner.color + (isFocusedOwner ? '70' : '40') : 'transparent';
            const cellBorder = owner ? owner.color : theme.line;
            return (
              <View
                key={c}
                style={[
                  styles.cell,
                  { backgroundColor: cellBg, borderColor: cellBorder },
                  isMine && !focusedPlayerId && styles.cellMine,
                  isFocusedOwner && styles.cellMine,
                  winLabels.length > 0 && styles.cellWinner,
                  isBubble && styles.cellBubble,
                  isDimmed && styles.cellDimmed,
                ]}
              >
                {owner ? (
                  <Text
                    style={[styles.cellInitial, isDimmed && { color: theme.muted }]}
                    numberOfLines={1}
                  >
                    {initials(owner.name)}
                  </Text>
                ) : null}
                {winLabels.length > 0 && <Text style={styles.cellWinBadge}>★</Text>}
                {isBubble && winLabels.length === 0 && <Text style={styles.cellBubbleBadge}>•</Text>}
              </View>
            );
          })}
            </View>
          ))}
        </View>
      </View>
      <Text style={styles.boardHint}>
        Rows = {homeAbbrev} last digit · cols = {awayAbbrev} last digit
        {state.revealed ? '' : ' · numbers hidden until host locks the board'}
      </Text>
    </View>
  );
}

// --- Host controls ---

function SnapshotButton({ pool, hostToken }: { pool: Pool; hostToken: string }) {
  const [busy, setBusy] = useState(false);
  const live = pool.state.live;
  const inGame = live?.state === 'in';
  const halftime = inGame && /half ?-?time/i.test(live?.detail || '');
  const enabled = inGame && !halftime;

  const save = async () => {
    setBusy(true);
    try {
      await snapshotNow(pool.id, hostToken);
    } catch (e) {
      notify('Snapshot failed', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const label = halftime
    ? 'Snapshots paused — halftime'
    : !inGame
      ? 'Snapshots only during live game'
      : 'Save snapshot now';

  return (
    <Pressable
      style={[styles.secondaryBtn, styles.btnRow, (busy || !enabled) && styles.btnDisabled]}
      disabled={busy || !enabled}
      onPress={save}
    >
      <Ionicons name="camera-outline" size={16} color={theme.text} />
      <Text style={styles.secondaryBtnText}>{label}</Text>
    </Pressable>
  );
}

function HostPlayersEditor({ pool, hostToken }: { pool: Pool; hostToken: string }) {
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [newPlayer, setNewPlayer] = useState('');

  const addPlayer = async () => {
    const trimmed = newPlayer.trim();
    if (!trimmed) return notify('Enter a name first');
    setBusy(true);
    try {
      await joinPool(pool.id, trimmed);
      setNewPlayer('');
    } catch (e) {
      notify('Could not add player', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (id: string, name: string) => {
    setEditingId(id);
    setEditName(name);
  };

  const saveEdit = async () => {
    if (!editingId) return;
    const trimmed = editName.trim();
    if (!trimmed) return notify('Name cannot be empty');
    setBusy(true);
    try {
      await renamePlayer(pool.id, editingId, hostToken, trimmed);
      setEditingId(null);
    } catch (e) {
      notify('Rename failed', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string, name: string) => {
    const msg = pool.state.revealed
      ? `Remove ${name} from the pool?\n\nThe board is locked. Their squares will become unowned (gray) for the rest of the game. Past bubble history and winners that reference them will show as "unclaimed".`
      : `Remove ${name} from the pool? Their squares (none yet) will be unassigned.`;
    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
      if (!window.confirm(msg)) return;
    }
    setBusy(true);
    try {
      await removePlayer(pool.id, id, hostToken);
    } catch (e) {
      notify('Remove failed', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View>
      <Text style={styles.label}>Players ({pool.state.players.length})</Text>
      <Text style={styles.helper}>
        Tap a name to rename. Tap × to remove (works mid-game too — their squares go unowned).
        Add seats below for friends who haven't joined yet.
      </Text>
      <View style={styles.playersRow}>
        {pool.state.players.map((p) =>
          editingId === p.id ? (
            <View key={p.id} style={[styles.editingChip, { borderColor: p.color }]}>
              <View style={[styles.playerDot, { backgroundColor: p.color }]} />
              <TextInput
                style={styles.editingInput}
                value={editName}
                onChangeText={setEditName}
                maxLength={24}
                autoFocus
                onSubmitEditing={saveEdit}
              />
              <Pressable onPress={saveEdit} disabled={busy} hitSlop={6}>
                <Ionicons name="checkmark" size={16} color={theme.gold} />
              </Pressable>
              <Pressable onPress={() => setEditingId(null)} disabled={busy} hitSlop={6}>
                <Ionicons name="close" size={16} color={theme.muted} />
              </Pressable>
            </View>
          ) : (
            <View key={p.id} style={[styles.playerChip, { borderColor: p.color }]}>
              <Pressable
                onPress={() => startEdit(p.id, p.name)}
                style={styles.chipMain}
                disabled={busy}
              >
                <View style={[styles.playerDot, { backgroundColor: p.color }]} />
                <Text style={styles.playerName}>{p.name}</Text>
                <Ionicons name="pencil-outline" size={11} color={theme.muted} />
              </Pressable>
              <Pressable
                onPress={() => remove(p.id, p.name)}
                hitSlop={4}
                style={styles.chipRemove}
                disabled={busy}
              >
                <Ionicons name="close" size={12} color={theme.muted} />
              </Pressable>
            </View>
          ),
        )}
      </View>

      {!pool.state.revealed && (
        <View style={[styles.row, { marginTop: 10 }]}>
          <TextInput
            style={[styles.input, { flex: 1 }]}
            placeholder="Add a player by name"
            placeholderTextColor={theme.muted}
            maxLength={24}
            value={newPlayer}
            onChangeText={setNewPlayer}
            onSubmitEditing={addPlayer}
          />
          <Pressable
            style={[styles.secondaryBtn, styles.btnRow, busy && styles.btnDisabled]}
            disabled={busy}
            onPress={addPlayer}
          >
            <Ionicons name="person-add-outline" size={16} color={theme.text} />
            <Text style={styles.secondaryBtnText}>Add</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

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
      notify('Could not reveal', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const recordWinner = async () => {
    const home = parseInt(winnerHome, 10);
    const away = parseInt(winnerAway, 10);
    if (Number.isNaN(home) || Number.isNaN(away)) {
      notify('Enter both scores first.');
      return;
    }
    if (!pool.state.rowDigits || !pool.state.colDigits) {
      notify('Reveal numbers before recording winners.');
      return;
    }
    const row = pool.state.rowDigits.indexOf(Math.abs(home) % 10);
    const col = pool.state.colDigits.indexOf(Math.abs(away) % 10);
    if (row < 0 || col < 0) {
      notify('Could not match scores to a square.');
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
      notify('Could not record winner', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveInterval = async () => {
    setBusy(true);
    try {
      await patchPool(pool.id, hostToken, { bubbleIntervalSec: interval });
    } catch (e) {
      notify('Could not update interval', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const playerCount = pool.state.players.length;
  const canLock = playerCount >= 2 && !pool.state.revealed;
  const lockLabel = pool.state.revealed
    ? 'Board locked'
    : playerCount < 2
      ? `Need ${2 - playerCount} more player${2 - playerCount === 1 ? '' : 's'} to start`
      : `Lock board · randomize for ${playerCount}`;

  const reshuffle = async () => {
    setBusy(true);
    try {
      // PATCH revealed:true while already revealed re-runs the random assignment
      // and re-shuffles the digits.
      await patchPool(pool.id, hostToken, { revealed: true });
    } catch (e) {
      notify('Could not reshuffle', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.panel}>
      <Text style={styles.label}>Host controls</Text>

      <HostPlayersEditor pool={pool} hostToken={hostToken} />

      <Text style={[styles.label, { marginTop: 10 }]}>Lock the board</Text>
      <Text style={styles.helper}>
        Server randomly distributes all 100 squares across the {playerCount} player
        {playerCount === 1 ? '' : 's'} and shuffles the row/column digits.
      </Text>
      <Pressable
        style={[styles.primaryBtn, styles.btnRow, (busy || !canLock) && styles.btnDisabled]}
        disabled={busy || !canLock}
        onPress={reveal}
      >
        <Ionicons
          name={pool.state.revealed ? 'lock-closed' : 'lock-open-outline'}
          size={16}
          color="#111"
        />
        <Text style={styles.primaryBtnText}>{lockLabel}</Text>
      </Pressable>

      {pool.state.revealed && (
        <Pressable
          style={[styles.secondaryBtn, styles.btnRow, busy && styles.btnDisabled]}
          disabled={busy}
          onPress={reshuffle}
        >
          <Ionicons name="shuffle" size={16} color={theme.text} />
          <Text style={styles.secondaryBtnText}>Reshuffle squares & numbers</Text>
        </Pressable>
      )}

      <Text style={[styles.label, { marginTop: 10 }]}>Bubble snapshot interval</Text>
      <Text style={styles.helper}>
        How often we record who's on the bubble. "End of Q" matches classic squares scoring
        (one snapshot per quarter); time-based intervals give denser history.
      </Text>
      <View style={styles.intervalRow}>
        {[
          { label: 'End of Q', value: 0 },
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

      {pool.state.revealed && isLocalApiUrl() && (
        <>
          <Text style={[styles.label, { marginTop: 10 }]}>Record quarter winner (dev)</Text>
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
      <View style={styles.labelRow}>
        <Ionicons name="trophy-outline" size={14} color={theme.gold} />
        <Text style={styles.label}>Quarter winners</Text>
      </View>
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
      <View style={styles.labelRow}>
        <Ionicons name="time-outline" size={14} color={theme.muted} />
        <Text style={styles.label}>Bubble history ({history.length})</Text>
      </View>
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
      <View style={styles.labelRow}>
        <Ionicons name="flame-outline" size={14} color={theme.hit} />
        <Text style={styles.label}>Biggest losers</Text>
      </View>
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
const LEFT_AXIS = 22;

const styles = StyleSheet.create({
  wrap: { padding: 12, gap: 12 },
  shell: { flex: 1, backgroundColor: theme.bg },
  tabBody: { padding: 12, gap: 12, paddingBottom: 24 },
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: theme.line,
    backgroundColor: theme.panel,
    paddingVertical: 6,
    paddingHorizontal: 6,
    paddingBottom: 14,
  },
  tabBtn: {
    flex: 1,
    paddingVertical: 6,
    alignItems: 'center',
    borderRadius: 8,
    gap: 2,
  },
  tabBtnActive: { backgroundColor: theme.panelAlt },
  tabIconWrap: { position: 'relative' },
  tabBadgeFloat: {
    position: 'absolute',
    top: -4,
    right: -10,
    backgroundColor: theme.gold,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 999,
    minWidth: 16,
    alignItems: 'center',
  },
  tabBadgeText: { color: '#111', fontSize: 9, fontWeight: '700' },
  tabLabel: { color: theme.muted, fontWeight: '700', fontSize: 11 },
  tabLabelActive: { color: theme.gold },
  btnRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  codeHintRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  editingChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    backgroundColor: theme.panelAlt,
  },
  editingInput: {
    color: theme.text,
    fontSize: 13,
    fontWeight: '600',
    paddingVertical: 0,
    minWidth: 80,
  },
  chipMain: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  chipRemove: { paddingLeft: 4 },
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
    borderBottomWidth: 1,
    borderBottomColor: theme.line,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerBack: { padding: 4 },
  headerLabel: { color: theme.muted, fontSize: 10, textTransform: 'uppercase', letterSpacing: 1 },
  headerName: { color: theme.text, fontSize: 16, fontWeight: '700' },
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

  boardTopAxis: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  boardMain: { flexDirection: 'row', alignItems: 'flex-start' },
  boardLeftAxis: {
    width: LEFT_AXIS,
    height: CELL * 11,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  boardLeftAxisLetter: {
    color: theme.muted,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0,
    lineHeight: 14,
  },
  boardLegendText: {
    color: theme.muted,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
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
  cellInitial: { color: theme.text, fontWeight: '700', fontSize: 10 },
  cellDimmed: { opacity: 0.18 },
  digitsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  digitChip: {
    backgroundColor: theme.panelAlt,
    borderColor: theme.line,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  digitChipWinner: { borderColor: theme.gold, backgroundColor: '#1d1a09' },
  digitChipText: { fontSize: 11, fontWeight: '700' },
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
