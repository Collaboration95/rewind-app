import { StatusBar } from 'expo-status-bar';
import { ScrollView, StyleSheet, Text } from 'react-native';

import { DemoProfilePicker } from './src/profiles/DemoProfilePicker';
import { DemoProfileProvider } from './src/profiles/DemoProfileProvider';

export default function App() {
  return (
    <DemoProfileProvider>
      <StatusBar style="auto" />
      <ScrollView style={styles.safeArea} contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={styles.title}>
          Rewind
        </Text>
        <Text style={styles.subtitle}>A small place for shared moments.</Text>

        <DemoProfilePicker />
      </ScrollView>
    </DemoProfileProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: '#F5F1EA',
    flex: 1,
  },
  content: {
    flexGrow: 1,
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
});
