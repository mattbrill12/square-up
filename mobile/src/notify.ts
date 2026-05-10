import { Alert, Platform } from 'react-native';

// Cross-platform alert. react-native-web's Alert.alert is a no-op, so we use
// window.alert there. On native, defer to RN's Alert which renders a real modal.
export function notify(title: string, message?: string): void {
  if (Platform.OS === 'web' && typeof window !== 'undefined' && typeof window.alert === 'function') {
    window.alert(message ? `${title}\n\n${message}` : title);
    return;
  }
  Alert.alert(title, message);
}
