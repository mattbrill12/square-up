import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useEffect, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import type { RootStackParamList } from '../../App';
import { createPool, getPool, listGames } from '../api';
import { notify } from '../notify';
import { listRecent, pushRecent, saveCreds, type RecentEntry } from '../persist';
import { theme } from '../theme';
import type { GameSummary } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'Create'>;

const INTERVAL_PRESETS = [
  { label: 'End of Q', value: 0 },
  { label: '30s', value: 30 },
  { label: '1 min', value: 60 },
  { label: '3 min', value: 180 },
  { label: '10 min', value: 600 },
];

export default function CreateScreen({ navigation }: Props) {
  const [games, setGames] = useState<GameSummary[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [eventId, setEventId] = useState<string>('');
  const [hostName, setHostName] = useState<string>('');
  const [interval, setInterval] = useState<number>(0);
  const [creating, setCreating] = useState(false);
  const [extraNames, setExtraNames] = useState<string>('');
  const [recent, setRecent] = useState<RecentEntry[]>([]);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    listRecent().then(setRecent);
  }, []);

  useEffect(() => {
    listGames()
      .then((r) => {
        setGames(r.games);
        const firstSelectable = r.games.find((g) => g.state !== 'post');
        if (firstSelectable) setEventId(firstSelectable.eventId);
      })
      .catch((e) => setLoadErr((e as Error).message));
  }, []);

  const parseExtras = (raw: string): string[] =>
    raw
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, 50);

  const submit = async () => {
    const name = hostName.trim();
    if (!eventId) return notify('Pick a game first');
    if (!name) return notify('Enter your name');
    const additionalPlayers = parseExtras(extraNames);
    setCreating(true);
    try {
      const created = await createPool(eventId, name, interval, additionalPlayers);
      await saveCreds(created.id, {
        hostToken: created.hostToken,
        playerId: created.hostPlayerId,
        playerToken: created.hostPlayerToken,
      });
      const game = created.state.game;
      const label = game ? `${game.awayAbbrev} @ ${game.homeAbbrev}` : 'Pool';
      await pushRecent({ id: created.id, label, createdAt: created.createdAt });
      navigation.replace('Pool', { poolId: created.id });
    } catch (e) {
      notify('Could not create pool', (e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const importFromPool = async (poolId: string) => {
    setImporting(true);
    try {
      const pool = await getPool(poolId);
      const names = pool.state.players.map((p) => p.name).filter(Boolean);
      // Drop the host's own name from the import list if it matches.
      const hostTrim = hostName.trim();
      const filtered = hostTrim ? names.filter((n) => n !== hostTrim) : names;
      const existing = parseExtras(extraNames);
      const merged = Array.from(new Set([...existing, ...filtered]));
      setExtraNames(merged.join(', '));
    } catch (e) {
      notify('Could not load that pool', (e as Error).message);
    } finally {
      setImporting(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <View style={styles.panel}>
        <Text style={styles.label}>Pick a game</Text>
        {loadErr && <Text style={styles.error}>{loadErr}</Text>}
        {!games && !loadErr && <ActivityIndicator color={theme.gold} />}
        {games && games.length === 0 && (
          <Text style={styles.muted}>No NBA games on the schedule today.</Text>
        )}
        {games &&
          games.map((g) => {
            const isFinal = g.state === 'post';
            return (
              <Pressable
                key={g.eventId}
                style={[
                  styles.gameRow,
                  eventId === g.eventId && !isFinal && styles.gameRowActive,
                  isFinal && styles.gameRowDisabled,
                ]}
                onPress={() => {
                  if (!isFinal) setEventId(g.eventId);
                }}
                disabled={isFinal}
              >
                <View style={styles.gameRowTop}>
                  <Text style={[styles.gameTitle, isFinal && styles.gameTextDim]}>
                    {g.awayAbbrev} @ {g.homeAbbrev}
                  </Text>
                  {isFinal && <Text style={styles.finalBadge}>FINAL</Text>}
                </View>
                <Text style={[styles.gameSub, isFinal && styles.gameTextDim]}>
                  {g.detail || g.name}
                </Text>
              </Pressable>
            );
          })}
      </View>

      <View style={styles.panel}>
        <Text style={styles.label}>Your name (host)</Text>
        <TextInput
          style={styles.input}
          placeholder="Your name"
          placeholderTextColor={theme.muted}
          maxLength={24}
          value={hostName}
          onChangeText={setHostName}
        />
      </View>

      <View style={styles.panel}>
        <Text style={styles.label}>Bubble snapshot frequency</Text>
        <Text style={styles.helper}>
          The "bubble" is whichever player's square matches the live score right now — this controls
          how often the server records a snapshot. "End of Q" only records at quarter boundaries
          (the classic squares scoring); shorter intervals give more granular history and more
          entries in the biggest-loser leaderboard.
        </Text>
        <View style={styles.intervalRow}>
          {INTERVAL_PRESETS.map((p) => (
            <Pressable
              key={p.value}
              style={[styles.intervalBtn, interval === p.value && styles.intervalBtnActive]}
              onPress={() => setInterval(p.value)}
            >
              <Text style={[styles.intervalText, interval === p.value && styles.intervalTextActive]}>
                {p.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={styles.panel}>
        <Text style={styles.label}>Add players (optional)</Text>
        <Text style={styles.helper}>
          Comma-separated or one per line. They'll start as empty seats — friends can take them
          via the share link, or you can leave them as is.
        </Text>
        <TextInput
          style={[styles.input, { minHeight: 80, textAlignVertical: 'top' }]}
          placeholder="Mike, Tony, Jay"
          placeholderTextColor={theme.muted}
          multiline
          value={extraNames}
          onChangeText={setExtraNames}
        />
        {recent.length > 0 && (
          <>
            <Text style={[styles.helper, { marginTop: 6 }]}>Or import members from a recent pool:</Text>
            {recent.slice(0, 5).map((r) => (
              <Pressable
                key={r.id}
                style={[styles.recentImportRow, importing && styles.btnDisabled]}
                disabled={importing}
                onPress={() => importFromPool(r.id)}
              >
                <Ionicons name="people-outline" size={14} color={theme.muted} />
                <Text style={styles.recentImportLabel}>{r.label}</Text>
                <Text style={styles.recentImportId}>{r.id}</Text>
                <Ionicons name="add" size={14} color={theme.accent} />
              </Pressable>
            ))}
          </>
        )}
      </View>

      <Pressable style={[styles.primaryBtn, creating && styles.btnDisabled]} disabled={creating} onPress={submit}>
        <Ionicons name="basketball-outline" size={18} color="#111" />
        <Text style={styles.primaryBtnText}>{creating ? 'Creating…' : 'Create pool'}</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: 16, gap: 14 },
  panel: {
    backgroundColor: theme.panel,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.line,
    padding: 14,
    gap: 8,
  },
  label: { color: theme.muted, fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 },
  helper: { color: theme.muted, fontSize: 12, lineHeight: 16 },
  muted: { color: theme.muted, fontSize: 13 },
  error: { color: theme.hit, fontSize: 13 },
  gameRow: {
    backgroundColor: theme.panelAlt,
    borderColor: theme.line,
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    gap: 4,
  },
  gameRowActive: { borderColor: theme.gold },
  gameRowDisabled: { opacity: 0.45 },
  gameRowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  gameTitle: { color: theme.text, fontWeight: '700', fontSize: 16 },
  gameSub: { color: theme.muted, fontSize: 12 },
  gameTextDim: { color: theme.muted },
  finalBadge: {
    color: theme.muted,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1,
    backgroundColor: theme.line,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  recentImportRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: theme.panelAlt,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginTop: 4,
  },
  recentImportLabel: { color: theme.text, fontWeight: '600', flex: 1 },
  recentImportId: { color: theme.muted, fontSize: 11, fontFamily: 'Menlo' },
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
  intervalRow: { flexDirection: 'row', gap: 8 },
  intervalBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.line,
    backgroundColor: theme.panelAlt,
    alignItems: 'center',
  },
  intervalBtnActive: { borderColor: theme.gold, backgroundColor: '#1d1a09' },
  intervalText: { color: theme.muted, fontWeight: '700' },
  intervalTextActive: { color: theme.gold },
  primaryBtn: {
    backgroundColor: theme.gold,
    borderRadius: 8,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  primaryBtnText: { color: '#111', fontWeight: '700', fontSize: 16 },
  btnDisabled: { opacity: 0.5 },
});
