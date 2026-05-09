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
import { getPool, joinPool } from '../api';
import { loadCreds, pushRecent, saveCreds } from '../persist';
import { theme } from '../theme';
import type { Pool } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'Join'>;

export default function JoinScreen({ navigation, route }: Props) {
  const { poolId } = route.params;
  const [pool, setPool] = useState<Pool | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // If we already have credentials, jump straight to the pool screen.
        const creds = await loadCreds(poolId);
        if (creds && (creds.playerToken || creds.hostToken)) {
          if (!cancelled) navigation.replace('Pool', { poolId });
          return;
        }
        const p = await getPool(poolId);
        if (!cancelled) setPool(p);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [poolId, navigation]);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return Alert.alert('Enter your name first');
    setBusy(true);
    try {
      const r = await joinPool(poolId, trimmed);
      await saveCreds(poolId, { playerId: r.playerId, playerToken: r.playerToken });
      const game = pool?.state.game;
      const label = game ? `${game.awayAbbrev} @ ${game.homeAbbrev}` : 'Pool';
      await pushRecent({ id: poolId, label, createdAt: Date.now() });
      navigation.replace('Pool', { poolId });
    } catch (e) {
      Alert.alert('Could not join', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>{error}</Text>
        <Pressable style={styles.secondaryBtn} onPress={() => navigation.goBack()}>
          <Text style={styles.secondaryBtnText}>Go back</Text>
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

  const game = pool.state.game;

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <View style={styles.panel}>
        <Text style={styles.label}>Joining pool</Text>
        {game ? (
          <>
            <Text style={styles.gameTitle}>
              {game.awayAbbrev} @ {game.homeAbbrev}
            </Text>
            <Text style={styles.gameSub}>{game.awayName} at {game.homeName}</Text>
          </>
        ) : (
          <Text style={styles.muted}>(game info loading)</Text>
        )}
        <Text style={styles.muted}>
          {pool.state.players.length} {pool.state.players.length === 1 ? 'player' : 'players'} so far ·
          {' '}{pool.state.assignments.filter((a) => a !== '').length} squares claimed
        </Text>
      </View>

      <View style={styles.panel}>
        <Text style={styles.label}>Your name</Text>
        <TextInput
          style={styles.input}
          placeholder="Tony"
          placeholderTextColor={theme.muted}
          maxLength={24}
          autoCorrect={false}
          value={name}
          onChangeText={setName}
        />
      </View>

      <Pressable style={[styles.primaryBtn, busy && styles.btnDisabled]} disabled={busy} onPress={submit}>
        <Text style={styles.primaryBtnText}>{busy ? 'Joining…' : 'Join pool'}</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: 16, gap: 14 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16, gap: 12 },
  panel: {
    backgroundColor: theme.panel,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.line,
    padding: 14,
    gap: 6,
  },
  label: { color: theme.muted, fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 },
  muted: { color: theme.muted, fontSize: 13 },
  error: { color: theme.hit, fontSize: 14 },
  gameTitle: { color: theme.text, fontWeight: '800', fontSize: 22 },
  gameSub: { color: theme.muted, fontSize: 13, marginBottom: 4 },
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
  primaryBtn: {
    backgroundColor: theme.gold,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
  },
  primaryBtnText: { color: '#111', fontWeight: '700', fontSize: 16 },
  secondaryBtn: {
    backgroundColor: theme.line,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    alignSelf: 'center',
  },
  secondaryBtnText: { color: theme.text, fontWeight: '700' },
  btnDisabled: { opacity: 0.5 },
});
