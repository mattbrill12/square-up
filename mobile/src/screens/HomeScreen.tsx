import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { useCallback, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import type { RootStackParamList } from '../../App';
import { listRecent, type RecentEntry } from '../persist';
import { theme } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Home'>;

export default function HomeScreen({ navigation }: Props) {
  const [recent, setRecent] = useState<RecentEntry[]>([]);
  const [code, setCode] = useState('');

  useFocusEffect(
    useCallback(() => {
      listRecent().then(setRecent);
    }, []),
  );

  const join = () => {
    const id = code.trim().toLowerCase();
    if (!id) {
      Alert.alert('Enter a pool code first');
      return;
    }
    navigation.navigate('Join', { poolId: id });
  };

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <View style={styles.heroPanel}>
        <Text style={styles.heroLabel}>Basketball squares</Text>
        <Text style={styles.heroTitle}>Square Up</Text>
        <Text style={styles.heroSub}>
          Pick a game. Claim your squares. See who's on the bubble in real time.
        </Text>
        <Pressable style={styles.primaryBtn} onPress={() => navigation.navigate('Create')}>
          <Text style={styles.primaryBtnText}>Create new pool</Text>
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
          <Pressable style={styles.secondaryBtn} onPress={join}>
            <Text style={styles.secondaryBtnText}>Join</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.panel}>
        <Text style={styles.label}>Recent pools</Text>
        {recent.length === 0 ? (
          <Text style={styles.muted}>No pools yet — create one above.</Text>
        ) : (
          recent.map((entry) => (
            <Pressable
              key={entry.id}
              style={styles.recentRow}
              onPress={() => navigation.navigate('Pool', { poolId: entry.id })}
            >
              <Text style={styles.recentLabel}>{entry.label}</Text>
              <Text style={styles.recentId}>{entry.id}</Text>
            </Pressable>
          ))
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: 16, gap: 14 },
  heroPanel: {
    backgroundColor: theme.panel,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.line,
    padding: 18,
    gap: 6,
  },
  heroLabel: {
    color: theme.muted,
    textTransform: 'uppercase',
    letterSpacing: 1,
    fontSize: 11,
  },
  heroTitle: { color: theme.text, fontSize: 32, fontWeight: '800' },
  heroSub: { color: theme.muted, fontSize: 13, lineHeight: 18, marginBottom: 8 },
  panel: {
    backgroundColor: theme.panel,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.line,
    padding: 14,
    gap: 8,
  },
  label: { color: theme.muted, fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 },
  muted: { color: theme.muted, fontSize: 13 },
  row: { flexDirection: 'row', gap: 8, alignItems: 'center' },
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
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 8,
  },
  primaryBtnText: { color: '#111', fontWeight: '700', fontSize: 15 },
  secondaryBtn: {
    backgroundColor: theme.line,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  secondaryBtnText: { color: theme.text, fontWeight: '700', fontSize: 14 },
  recentRow: {
    backgroundColor: theme.panelAlt,
    borderRadius: 8,
    padding: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 6,
  },
  recentLabel: { color: theme.text, fontWeight: '600', flex: 1 },
  recentId: { color: theme.muted, fontSize: 12, fontFamily: 'Menlo' },
});
