import { NavigationContainer, type Theme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import CreateScreen from './src/screens/CreateScreen';
import HomeScreen from './src/screens/HomeScreen';
import JoinScreen from './src/screens/JoinScreen';
import PoolScreen from './src/screens/PoolScreen';
import { theme as palette } from './src/theme';

export type RootStackParamList = {
  Home: undefined;
  Create: undefined;
  Join: { poolId: string };
  Pool: { poolId: string };
};

const Stack = createNativeStackNavigator<RootStackParamList>();

const navTheme: Theme = {
  dark: true,
  colors: {
    primary: palette.gold,
    background: palette.bg,
    card: palette.panel,
    text: palette.text,
    border: palette.line,
    notification: palette.hit,
  },
  fonts: {
    regular: { fontFamily: 'System', fontWeight: '400' },
    medium: { fontFamily: 'System', fontWeight: '500' },
    bold: { fontFamily: 'System', fontWeight: '700' },
    heavy: { fontFamily: 'System', fontWeight: '800' },
  },
};

export default function App() {
  return (
    <SafeAreaProvider>
      <NavigationContainer theme={navTheme}>
        <Stack.Navigator
          screenOptions={{
            headerStyle: { backgroundColor: palette.panel },
            headerTintColor: palette.text,
            contentStyle: { backgroundColor: palette.bg },
          }}
        >
          <Stack.Screen name="Home" component={HomeScreen} options={{ title: 'Square Up' }} />
          <Stack.Screen name="Create" component={CreateScreen} options={{ title: 'New Pool' }} />
          <Stack.Screen name="Join" component={JoinScreen} options={{ title: 'Join Pool' }} />
          <Stack.Screen name="Pool" component={PoolScreen} options={{ title: 'Pool' }} />
        </Stack.Navigator>
      </NavigationContainer>
      <StatusBar style="light" />
    </SafeAreaProvider>
  );
}
