import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useCallback, useState } from 'react';
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
import { getPool } from '../api';
import { notify } from '../notify';
import { listRecent, type RecentEntry } from '../persist';
import { theme } from '../theme';
import type { Pool } from '../types';

type Props = NativeStackScreenProps<RootStackParamList, 'Home'>;

type Enriched = {
  entry: RecentEntry;
  pool: Pool | null;
  error?: boolean;
};

type Group = 'live' | 'upcoming' | 'recent';

function groupOf(p: Pool | null): Group {
  const state = p?.state.live?.state;
  if (state === 'in') return 'live';
  if (state === 'post') return 'recent';
  return 'upcoming';
}

function formatTipoff(iso?: string): string {
  if (!iso) return 'TBD';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function HomeScreen({ navigation }: Props) {
  const [items, setItems] = useState<Enriched[]>([]);
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState('');

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        const recent = await listRecent();
        if (cancelled) return;
        setItems(recent.map((entry) => ({ entry, pool: null })));
        setLoading(true);
        const enriched = await Promise.all(
          recent.map(async (entry): Promise<Enriched> => {
            try {
              const pool = await getPool(entry.id);
              return { entry, pool };
            } catch {
              return { entry, pool: null, error: true };
            }
          }),
        );
        if (!cancelled) {
          setItems(enriched);
          setLoading(false);
        }
      })();
      return () => {
        cancelled = true;
      };
    }, []),
  );

  const join = () => {
    const id = code.trim().toLowerCase();
    if (!id) return notify('Enter a pool code first');
    navigation.navigate('Join', { poolId: id });
  };

  const live = items.filter((i) => i.pool && groupOf(i.pool) === 'live');
  const upcoming = items.filter((i) => i.pool && groupOf(i.pool) === 'upcoming');
  const recent = items.filter((i) => i.pool && groupOf(i.pool) === 'recent');
  const broken = items.filter((i) => !i.pool && i.error);

  const isEmpty = items.length === 0;

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <View style={styles.heroRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.heroLabel}>Basketball squares</Text>
          <Text style={styles.heroTitle}>Square Up</Text>
        </View>
        <Pressable style={styles.primaryBtn} onPress={() => navigation.navigate('Create')}>
          <Ionicons name="add-circle-outline" size={16} color="#111" />
          <Text style={styles.primaryBtnText}>Create</Text>
        </Pressable>
      </View>

      <View style={styles.panel}>
        <Text style={styles.label}>Have a pool code?</Text>
        <View style={styles.row}>
          <TextInput
            style={styles.input}
            placeholder="e.g. aa352d7a"
            placeholderTextColor={theme.muted}
            autoCapitalize="none"
            autoCorrect={false}
            value={code}
            onChangeText={setCode}
            onSubmitEditing={join}
          />
          <Pressable style={[styles.secondaryBtn, styles.btnRow]} onPress={join}>
            <Ionicons name="enter-outline" size={16} color={theme.text} />
            <Text style={styles.secondaryBtnText}>Join</Text>
          </Pressable>
        </View>
      </View>

      {isEmpty ? (
        <View style={styles.emptyPanel}>
          <Ionicons name="basketball-outline" size={28} color={theme.muted} />
          <Text style={styles.emptyTitle}>No pools yet</Text>
          <Text style={styles.emptySub}>
            Create one above, or paste a code from a friend to join their lobby.
          </Text>
        </View>
      ) : (
        <>
          {live.length > 0 && (
            <Section
              title="Live now"
              icon="pulse-outline"
              accent={theme.hit}
              items={live}
              navigation={navigation}
            />
          )}
          {upcoming.length > 0 && (
            <Section
              title="Upcoming"
              icon="time-outline"
              accent={theme.gold}
              items={upcoming}
              navigation={navigation}
            />
          )}
          {recent.length > 0 && (
            <Section
              title="Recent"
              icon="trophy-outline"
              accent={theme.muted}
              items={recent}
              navigation={navigation}
            />
          )}
          {broken.length > 0 && (
            <Section
              title="Unavailable"
              icon="alert-circle-outline"
              accent={theme.muted}
              items={broken}
              navigation={navigation}
              brokenLabel
            />
          )}
          {loading && (
            <View style={styles.loadingRow}>
              <ActivityIndicator color={theme.muted} size="small" />
              <Text style={styles.loadingText}>Refreshing pool status…</Text>
            </View>
          )}
        </>
      )}
    </ScrollView>
  );
}

function Section({
  title,
  icon,
  accent,
  items,
  navigation,
  brokenLabel,
}: {
  title: string;
  icon: keyof typeof Ionicons.glyphMap;
  accent: string;
  items: Enriched[];
  navigation: Props['navigation'];
  brokenLabel?: boolean;
}) {
  return (
    <View style={styles.panel}>
      <View style={styles.sectionHeader}>
        <Ionicons name={icon} size={14} color={accent} />
        <Text style={styles.sectionTitle}>
          {title} ({items.length})
        </Text>
      </View>
      {items.map((i) => (
        <PoolRow
          key={i.entry.id}
          entry={i}
          accent={accent}
          navigation={navigation}
          brokenLabel={brokenLabel}
        />
      ))}
    </View>
  );
}

function PoolRow({
  entry,
  accent,
  navigation,
  brokenLabel,
}: {
  entry: Enriched;
  accent: string;
  navigation: Props['navigation'];
  brokenLabel?: boolean;
}) {
  const game = entry.pool?.state.game;
  const live = entry.pool?.state.live;
  const playerCount = entry.pool?.state.players.length ?? 0;
  const claimedSeats = entry.pool?.state.players.filter((p) => p.claimed).length ?? 0;
  const title = game ? `${game.awayAbbrev} @ ${game.homeAbbrev}` : entry.entry.label;

  let detail = '';
  if (brokenLabel) {
    detail = 'pool not found';
  } else if (live?.state === 'in') {
    detail = live.detail || 'live';
  } else if (live?.state === 'post') {
    detail = `Final ${live.away}-${live.home}`;
  } else if (live?.state === 'pre') {
    detail = formatTipoff(game?.date);
  } else {
    detail = 'open';
  }

  return (
    <Pressable
      style={styles.poolRow}
      onPress={() => navigation.navigate('Pool', { poolId: entry.entry.id })}
    >
      <View style={[styles.statusDot, { backgroundColor: accent }]} />
      <View style={{ flex: 1 }}>
        <Text style={styles.poolRowTitle}>{title}</Text>
        <Text style={styles.poolRowSub}>
          {detail}
          {!brokenLabel && (
            <>
              {' · '}
              {claimedSeats}/{playerCount} {playerCount === 1 ? 'player' : 'players'}
            </>
          )}
        </Text>
      </View>
      <Text style={styles.poolRowCode}>{entry.entry.id}</Text>
      <Ionicons name="chevron-forward" size={16} color={theme.muted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: 16, gap: 12 },
  heroRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 12,
    marginBottom: 4,
  },
  heroLabel: {
    color: theme.muted,
    textTransform: 'uppercase',
    letterSpacing: 1,
    fontSize: 11,
  },
  heroTitle: { color: theme.text, fontSize: 32, fontWeight: '800' },
  panel: {
    backgroundColor: theme.panel,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.line,
    padding: 14,
    gap: 8,
  },
  label: { color: theme.muted, fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  btnRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  input: {
    flex: 1,
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
    paddingHorizontal: 14,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  primaryBtnText: { color: '#111', fontWeight: '700', fontSize: 14 },
  secondaryBtn: {
    backgroundColor: theme.line,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  secondaryBtnText: { color: theme.text, fontWeight: '700', fontSize: 14 },
  emptyPanel: {
    backgroundColor: theme.panel,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.line,
    padding: 24,
    alignItems: 'center',
    gap: 8,
  },
  emptyTitle: { color: theme.text, fontSize: 16, fontWeight: '700' },
  emptySub: { color: theme.muted, fontSize: 13, textAlign: 'center', maxWidth: 280 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  sectionTitle: {
    color: theme.muted,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  poolRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: theme.panelAlt,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  poolRowTitle: { color: theme.text, fontWeight: '700', fontSize: 14 },
  poolRowSub: { color: theme.muted, fontSize: 12, marginTop: 1 },
  poolRowCode: { color: theme.muted, fontSize: 11, fontFamily: 'Menlo' },
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 },
  loadingText: { color: theme.muted, fontSize: 12 },
});
