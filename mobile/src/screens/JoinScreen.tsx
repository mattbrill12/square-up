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
import { claimSeat, getPool, joinPool } from '../api';
import { notify } from '../notify';
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

  const finish = async (playerId: string, playerToken: string) => {
    await saveCreds(poolId, { playerId, playerToken });
    const game = pool?.state.game;
    const label = game ? `${game.awayAbbrev} @ ${game.homeAbbrev}` : 'Pool';
    await pushRecent({ id: poolId, label, createdAt: Date.now() });
    navigation.replace('Pool', { poolId });
  };

  const observe = async () => {
    await saveCreds(poolId, { observer: true });
    const game = pool?.state.game;
    const label = game ? `${game.awayAbbrev} @ ${game.homeAbbrev}` : 'Pool';
    await pushRecent({ id: poolId, label, createdAt: Date.now() });
    navigation.replace('Pool', { poolId });
  };

  const joinAsNew = async () => {
    const trimmed = name.trim();
    if (!trimmed) return notify('Enter your name first');
    setBusy(true);
    try {
      const r = await joinPool(poolId, trimmed);
      await finish(r.playerId, r.playerToken);
    } catch (e) {
      notify('Could not join', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const takeSeat = async (playerId: string, playerName: string) => {
    setBusy(true);
    try {
      const trimmedName = name.trim();
      const r = await claimSeat(poolId, playerId, trimmedName);
      await finish(r.playerId, r.playerToken);
    } catch (e) {
      notify(`Could not claim ${playerName}'s seat`, (e as Error).message);
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
  const seats = pool.state.players;

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <View style={styles.panel}>
        <Text style={styles.label}>Joining pool</Text>
        {game ? (
          <>
            <Text style={styles.gameTitle}>
              {game.awayAbbrev} @ {game.homeAbbrev}
            </Text>
            <Text style={styles.gameSub}>
              {game.awayName} at {game.homeName}
            </Text>
          </>
        ) : (
          <Text style={styles.muted}>(game info loading)</Text>
        )}
        <Text style={styles.muted}>
          {seats.length} {seats.length === 1 ? 'player' : 'players'} in this pool
          {pool.state.revealed ? ' · board locked' : ''}
        </Text>
      </View>

      <View style={styles.panel}>
        <Text style={styles.label}>Your name</Text>
        <TextInput
          style={styles.input}
          placeholder="Your name"
          placeholderTextColor={theme.muted}
          maxLength={24}
          autoCorrect={false}
          value={name}
          onChangeText={setName}
        />
        <Pressable
          style={[styles.primaryBtn, busy && styles.btnDisabled]}
          disabled={busy}
          onPress={joinAsNew}
        >
          <Text style={styles.primaryBtnText}>
            {busy ? 'Joining…' : 'Join as new player'}
          </Text>
        </Pressable>
      </View>

      {seats.length > 0 && (
        <View style={styles.panel}>
          <Text style={styles.label}>Or take an existing seat</Text>
          <Text style={styles.helper}>
            The host may have added a seat for you. Tap an open seat to claim it.
            Seats already held by a real player are locked.
          </Text>
          {seats.map((p) => {
            const isTaken = p.claimed;
            return (
              <Pressable
                key={p.id}
                style={[
                  styles.seatRow,
                  isTaken && styles.seatRowTaken,
                  busy && styles.btnDisabled,
                ]}
                disabled={busy || isTaken}
                onPress={() => takeSeat(p.id, p.name)}
              >
                <View style={[styles.playerDot, { backgroundColor: p.color }]} />
                <Ionicons
                  name={isTaken ? 'lock-closed-outline' : 'person-outline'}
                  size={14}
                  color={theme.muted}
                />
                <Text style={[styles.seatName, isTaken && styles.seatNameTaken]}>{p.name}</Text>
                {isTaken ? (
                  <Text style={styles.seatHintTaken}>taken</Text>
                ) : (
                  <Ionicons name="arrow-forward" size={14} color={theme.accent} />
                )}
              </Pressable>
            );
          })}
        </View>
      )}

      <View style={styles.panel}>
        <Text style={styles.label}>Just watching?</Text>
        <Text style={styles.helper}>
          Observe the live game and standings without taking a seat. Your name won't show up
          anywhere in the lobby.
        </Text>
        <Pressable
          style={[styles.secondaryBtn, busy && styles.btnDisabled]}
          disabled={busy}
          onPress={observe}
        >
          <Ionicons name="eye-outline" size={16} color={theme.text} />
          <Text style={styles.secondaryBtnText}>Observe only</Text>
        </Pressable>
      </View>
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
    gap: 8,
  },
  label: { color: theme.muted, fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 },
  helper: { color: theme.muted, fontSize: 12, lineHeight: 16 },
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
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  secondaryBtnText: { color: theme.text, fontWeight: '700' },
  btnDisabled: { opacity: 0.5 },
  seatRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: theme.panelAlt,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  playerDot: { width: 10, height: 10, borderRadius: 5 },
  seatName: { color: theme.text, fontWeight: '700', flex: 1 },
  seatNameTaken: { color: theme.muted },
  seatRowTaken: { opacity: 0.6 },
  seatHintTaken: {
    color: theme.muted,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
});
