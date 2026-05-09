import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useEffect, useState } from 'react';
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
import { createPool, listGames } from '../api';
import { pushRecent, saveCreds } from '../persist';
import { theme } from '../theme';
import type { GameSummary } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'Create'>;

const INTERVAL_PRESETS = [
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
  const [interval, setInterval] = useState<number>(60);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    listGames()
      .then((r) => {
        setGames(r.games);
        if (r.games.length > 0) setEventId(r.games[0].eventId);
      })
      .catch((e) => setLoadErr((e as Error).message));
  }, []);

  const submit = async () => {
    const name = hostName.trim();
    if (!eventId) return Alert.alert('Pick a game first');
    if (!name) return Alert.alert('Enter your name');
    setCreating(true);
    try {
      const created = await createPool(eventId, name, interval);
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
      Alert.alert('Could not create pool', (e as Error).message);
    } finally {
      setCreating(false);
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
          games.map((g) => (
            <Pressable
              key={g.eventId}
              style={[styles.gameRow, eventId === g.eventId && styles.gameRowActive]}
              onPress={() => setEventId(g.eventId)}
            >
              <Text style={styles.gameTitle}>
                {g.awayAbbrev} @ {g.homeAbbrev}
              </Text>
              <Text style={styles.gameSub}>{g.detail || g.name}</Text>
            </Pressable>
          ))}
      </View>

      <View style={styles.panel}>
        <Text style={styles.label}>Your name (host)</Text>
        <TextInput
          style={styles.input}
          placeholder="Matt"
          placeholderTextColor={theme.muted}
          maxLength={24}
          value={hostName}
          onChangeText={setHostName}
        />
      </View>

      <View style={styles.panel}>
        <Text style={styles.label}>Bubble snapshot frequency</Text>
        <Text style={styles.helper}>
          How often the server records who's on the bubble. The leaderboard counts how many times
          each player was on the bubble.
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

      <Pressable style={[styles.primaryBtn, creating && styles.btnDisabled]} disabled={creating} onPress={submit}>
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
  gameTitle: { color: theme.text, fontWeight: '700', fontSize: 16 },
  gameSub: { color: theme.muted, fontSize: 12 },
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
    alignItems: 'center',
  },
  primaryBtnText: { color: '#111', fontWeight: '700', fontSize: 16 },
  btnDisabled: { opacity: 0.5 },
});
