import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';

export default function App() {
  return (
    <View style={styles.safeArea}>
      <StatusBar style="auto" />
      <View style={styles.content}>
        <Text accessibilityRole="header" style={styles.title}>
          Rewind
        </Text>
        <Text style={styles.subtitle}>A small place for shared moments.</Text>

        <View accessible accessibilityLabel="Local demo shell status" style={styles.statusCard}>
          <Text style={styles.eyebrow}>Local demo</Text>
          <Text style={styles.statusTitle}>Foundation shell ready</Text>
          <Text style={styles.statusBody}>
            Rewind is running locally. Group, camera, chat, and archive experiences will be added in
            later sprint work.
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: '#F5F1EA',
    flex: 1,
  },
  content: {
    flex: 1,
    gap: 20,
    justifyContent: 'center',
    padding: 32,
  },
  title: {
    color: '#1D2622',
    fontSize: 48,
    fontWeight: '700',
    letterSpacing: -1,
  },
  subtitle: {
    color: '#53615B',
    fontSize: 18,
    lineHeight: 26,
  },
  statusCard: {
    backgroundColor: '#E4EEE7',
    borderColor: '#B8CCBF',
    borderRadius: 20,
    borderWidth: 1,
    gap: 8,
    maxWidth: 520,
    padding: 24,
  },
  eyebrow: {
    color: '#236341',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  statusTitle: {
    color: '#1D2622',
    fontSize: 22,
    fontWeight: '700',
  },
  statusBody: {
    color: '#3D4B44',
    fontSize: 16,
    lineHeight: 24,
  },
});
