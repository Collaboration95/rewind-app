import { useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { DemoProfilePicker } from './src/profiles/DemoProfilePicker';
import { DemoProfileProvider } from './src/profiles/DemoProfileProvider';

const COLORS = {
  accent: '#FFA572',
  background: '#252326',
  deep: '#1D1B1E',
  edge: '#BBA270',
  ink: '#F9EBD5',
  line: '#51474A',
  muted: '#B9ABA0',
  paper: '#302D30',
};

const lockedMoments = [1, 2, 3];

const ROUTES = [
  { key: 'home', label: 'Home' },
  { key: 'camera', label: 'Camera' },
  { key: 'chat', label: 'Chat' },
  { key: 'archive', label: 'Archive' },
] as const;

type RouteKey = (typeof ROUTES)[number]['key'];
type UnavailableRouteKey = Exclude<RouteKey, 'home'>;

const unavailableScreens: Record<UnavailableRouteKey, { description: string; title: string }> = {
  archive: {
    description:
      'Archive playback is not implemented. Locked moments remain unavailable until reveal.',
    title: 'Archive',
  },
  camera: {
    description: 'Camera capture and permissions are not implemented in this Sprint 0 demo.',
    title: 'Camera',
  },
  chat: {
    description: 'Chat is not implemented. No messages are being sent or stored.',
    title: 'Chat',
  },
};

export default function App() {
  const [activeRoute, setActiveRoute] = useState<RouteKey>('home');

  return (
    <SafeAreaProvider>
      <DemoProfileProvider>
        <StatusBar style="light" />

        <SafeAreaView
          edges={['top', 'right', 'bottom', 'left']}
          style={styles.page}
          testID="application-safe-area"
        >
          <View style={styles.screen}>
            {activeRoute === 'home' ? <HomeScreen /> : <UnavailableScreen route={activeRoute} />}
            <MainNavigation activeRoute={activeRoute} onNavigate={setActiveRoute} />
          </View>
        </SafeAreaView>
      </DemoProfileProvider>
    </SafeAreaProvider>
  );
}

function AppHeader() {
  return (
    <View style={styles.topBar}>
      <Text style={styles.wordmark}>REWIND</Text>
      <View accessibilityLabel="Local demo data" style={styles.demoBadge}>
        <Text style={styles.demoBadgeText}>LOCAL DEMO</Text>
      </View>
    </View>
  );
}

function HomeScreen() {
  return (
    <ScrollView
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
      style={styles.homeScroll}
      testID="home-scroll"
    >
      <AppHeader />

      <DemoProfilePicker />

      <View>
        <Text style={styles.label}>HOME</Text>
        <Text accessibilityRole="header" style={styles.title}>
          Weekend People
        </Text>
        <Text style={styles.mutedText}>Shared capsule · Sample group</Text>
      </View>

      <View
        accessible
        accessibilityLabel="Current capsule. Reveal in 2 days. 4 of 5 members added a moment."
        style={styles.panel}
      >
        <Text style={styles.label}>CURRENT CAPSULE</Text>
        <Text style={styles.panelTitle}>Reveal in 2 days</Text>
        <Text style={styles.bodyText}>4 of 5 members added a moment</Text>
      </View>

      <View style={styles.section}>
        <Text style={styles.label}>SEALED MOMENTS</Text>
        <View accessibilityLabel="Three sealed local demo moments" style={styles.momentRow}>
          {lockedMoments.map((moment) => (
            <View
              accessible
              accessibilityLabel={`Locked demo moment ${moment} of 3`}
              key={moment}
              style={styles.momentPlaceholder}
            >
              <Text style={styles.lockedText}>LOCKED</Text>
            </View>
          ))}
        </View>
      </View>

      <View
        accessible
        accessibilityLabel="Weekly prompt: What made you pause and smile?"
        style={styles.panel}
      >
        <Text style={styles.label}>THIS WEEK</Text>
        <Text style={styles.prompt}>What made you pause and smile?</Text>
      </View>

      <View
        accessible
        accessibilityLabel="Weekly quota. 2 of 5 moments used."
        style={styles.quotaRow}
      >
        <Text style={styles.label}>WEEKLY QUOTA</Text>
        <Text style={styles.bodyText}>2 / 5 moments</Text>
      </View>

      <Pressable
        accessibilityLabel="Add a moment"
        accessibilityRole="button"
        accessibilityState={{ disabled: true }}
        disabled
        style={styles.disabledButton}
      >
        <Text style={styles.disabledButtonText}>Add a moment</Text>
      </Pressable>
      <Text style={styles.helperText} testID="home-content-end">
        Camera is not available in this task.
      </Text>
    </ScrollView>
  );
}

function UnavailableScreen({ route }: { route: UnavailableRouteKey }) {
  const screen = unavailableScreens[route];

  return (
    <View style={styles.unavailableScreen}>
      <AppHeader />
      <View>
        <Text style={styles.label}>{screen.title.toUpperCase()}</Text>
        <Text accessibilityRole="header" style={styles.title}>
          {screen.title}
        </Text>
      </View>
      <View
        accessible
        accessibilityLabel={`${screen.title} unavailable status`}
        style={styles.unavailablePanel}
      >
        <Text style={styles.panelTitle}>Not available yet</Text>
        <Text style={styles.bodyText}>{screen.description}</Text>
      </View>
    </View>
  );
}

function MainNavigation({
  activeRoute,
  onNavigate,
}: {
  activeRoute: RouteKey;
  onNavigate: (route: RouteKey) => void;
}) {
  return (
    <View accessibilityRole="tablist" style={styles.navigation} testID="main-navigation">
      {ROUTES.map((route) => {
        const isSelected = route.key === activeRoute;

        return (
          <Pressable
            accessibilityHint={`Shows the ${route.label} area`}
            accessibilityLabel={route.label}
            accessibilityRole="tab"
            accessibilityState={{ selected: isSelected }}
            key={route.key}
            onPress={() => onNavigate(route.key)}
            style={[styles.tab, isSelected && styles.selectedTab]}
            testID={`nav-${route.key}`}
          >
            <Text style={[styles.tabLabel, isSelected && styles.selectedTabLabel]}>
              {route.label}
            </Text>
            <Text style={styles.tabState}>{isSelected ? 'SELECTED' : ' '}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    alignItems: 'center',
    backgroundColor: COLORS.deep,
    flex: 1,
  },
  screen: {
    backgroundColor: COLORS.background,
    borderColor: COLORS.line,
    borderWidth: 1,
    flex: 1,
    maxWidth: 390,
    width: '100%',
  },
  content: {
    flexGrow: 1,
    gap: 18,
    padding: 24,
    paddingBottom: 32,
  },
  homeScroll: {
    flex: 1,
  },
  topBar: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  wordmark: {
    color: COLORS.ink,
    fontSize: 14,
    fontWeight: '800',
    letterSpacing: 2,
  },
  demoBadge: {
    backgroundColor: COLORS.paper,
    borderColor: COLORS.accent,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  demoBadgeText: {
    color: COLORS.accent,
    fontSize: 10,
    fontWeight: '700',
  },
  label: {
    color: COLORS.edge,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
  },
  title: {
    color: COLORS.ink,
    fontSize: 30,
    fontWeight: '700',
    marginTop: 6,
  },
  mutedText: {
    color: COLORS.muted,
    fontSize: 14,
    marginTop: 4,
  },
  panel: {
    backgroundColor: COLORS.paper,
    borderColor: COLORS.line,
    borderRadius: 10,
    borderWidth: 1,
    gap: 8,
    padding: 16,
  },
  panelTitle: {
    color: COLORS.ink,
    fontSize: 22,
    fontWeight: '700',
  },
  bodyText: {
    color: COLORS.muted,
    fontSize: 14,
  },
  section: {
    gap: 8,
  },
  momentRow: {
    flexDirection: 'row',
    gap: 8,
  },
  momentPlaceholder: {
    alignItems: 'center',
    aspectRatio: 0.75,
    backgroundColor: COLORS.deep,
    borderColor: COLORS.edge,
    borderRadius: 6,
    borderStyle: 'dashed',
    borderWidth: 1,
    flex: 1,
    justifyContent: 'center',
  },
  lockedText: {
    color: COLORS.edge,
    fontSize: 10,
    fontWeight: '700',
  },
  prompt: {
    color: COLORS.ink,
    fontSize: 18,
    fontWeight: '600',
    lineHeight: 24,
  },
  quotaRow: {
    alignItems: 'center',
    borderBottomColor: COLORS.line,
    borderBottomWidth: 1,
    borderTopColor: COLORS.line,
    borderTopWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 14,
  },
  disabledButton: {
    alignItems: 'center',
    backgroundColor: COLORS.paper,
    borderColor: COLORS.line,
    borderRadius: 8,
    borderWidth: 1,
    padding: 14,
  },
  disabledButtonText: {
    color: COLORS.muted,
    fontSize: 15,
    fontWeight: '700',
  },
  helperText: {
    color: COLORS.muted,
    fontSize: 12,
    marginTop: -12,
    textAlign: 'center',
  },
  unavailableScreen: {
    flex: 1,
    gap: 24,
    padding: 24,
  },
  unavailablePanel: {
    backgroundColor: COLORS.paper,
    borderColor: COLORS.line,
    borderRadius: 10,
    borderWidth: 1,
    gap: 10,
    padding: 20,
  },
  navigation: {
    borderTopColor: COLORS.line,
    borderTopWidth: 1,
    flexDirection: 'row',
    minHeight: 68,
  },
  tab: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 4,
    paddingVertical: 10,
  },
  selectedTab: {
    backgroundColor: COLORS.paper,
    borderTopColor: COLORS.accent,
    borderTopWidth: 2,
  },
  tabLabel: {
    color: COLORS.muted,
    fontSize: 12,
    fontWeight: '600',
  },
  selectedTabLabel: {
    color: COLORS.ink,
  },
  tabState: {
    color: COLORS.accent,
    fontSize: 8,
    fontWeight: '700',
    marginTop: 4,
  },
});
