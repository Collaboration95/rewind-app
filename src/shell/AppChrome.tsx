import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { useChatUnread } from '../chat/unread';
import { DebugChip } from '../debug/DebugSheet';
import type { DebugScreen } from '../debug/scenarios';
import { useI18n } from '../i18n/LanguageProvider';
import { COLORS, FONTS } from '../theme';

export const ROUTES = [
  { key: 'home', label: 'Home' },
  { key: 'camera', label: 'Camera' },
  { key: 'chat', label: 'Chat' },
  { key: 'archive', label: 'Archive' },
  { key: 'settings', label: 'Settings' },
] as const;

export type RouteKey = (typeof ROUTES)[number]['key'];

/** Fixed app bar above each screen's own scroll area. */
export function AppHeader({ debugScreen }: { debugScreen?: DebugScreen }) {
  const { t } = useI18n();
  return (
    <View style={styles.header} testID="app-header">
      <View accessibilityLabel="Rewind" accessible style={styles.brand}>
        <Text style={styles.wordmark}>Rewind</Text>
        <View style={styles.brandDot} />
      </View>
      <View style={styles.headerRight}>
        {debugScreen ? <DebugChip screen={debugScreen} /> : null}
        <View accessibilityLabel={t('Local demo data')} style={styles.demoBadge}>
          <Text style={styles.demoBadgeText}>{t('LOCAL DEMO')}</Text>
        </View>
      </View>
    </View>
  );
}

function NavMark({ route, selected }: { route: RouteKey; selected: boolean }) {
  const color = selected ? COLORS.ink : COLORS.faint;
  switch (route) {
    case 'home':
      return (
        <View style={styles.markBox}>
          <View style={[styles.homeRoof, { borderBottomColor: color }]} />
          <View style={[styles.homeBody, { borderColor: color }]} />
        </View>
      );
    case 'camera':
      return (
        <View style={styles.markBox}>
          <View style={[styles.ring, { borderColor: color }]}>
            <View style={[styles.dot, { backgroundColor: color }]} />
          </View>
        </View>
      );
    case 'chat':
      return (
        <View style={[styles.markBox, styles.lines]}>
          {[16, 16, 10].map((width, index) => (
            <View key={index} style={[styles.line, { backgroundColor: color, width }]} />
          ))}
        </View>
      );
    case 'archive':
      return (
        <View style={styles.markBox}>
          <View style={[styles.box, { borderColor: color }]}>
            <View style={[styles.boxLid, { backgroundColor: color }]} />
          </View>
        </View>
      );
    default:
      return (
        <View style={styles.markBox}>
          <View style={[styles.gear, { borderColor: color }]}>
            <View style={[styles.gearHub, { borderColor: color }]} />
          </View>
        </View>
      );
  }
}

export function MainNavigation({
  activeRoute,
  backgroundHidden,
  onNavigate,
}: {
  activeRoute: RouteKey;
  backgroundHidden: boolean;
  onNavigate: (route: RouteKey) => void;
}) {
  const { t } = useI18n();
  const { unreadCount } = useChatUnread();
  return (
    <View
      accessibilityElementsHidden={backgroundHidden}
      aria-hidden={Platform.OS === 'web' ? backgroundHidden : undefined}
      accessibilityRole="tablist"
      importantForAccessibility={backgroundHidden ? 'no-hide-descendants' : 'auto'}
      nativeID="main-navigation"
      style={styles.navigation}
      testID="main-navigation"
    >
      {ROUTES.map((route) => {
        const isSelected = route.key === activeRoute;
        const label = t(route.label);
        return (
          <Pressable
            accessibilityHint={t('Shows the {area} area', { area: label })}
            accessibilityLabel={
              route.key === 'chat' && unreadCount > 0
                ? t(
                    unreadCount === 1
                      ? '{label}, {count} unread message'
                      : '{label}, {count} unread messages',
                    { count: unreadCount, label },
                  )
                : label
            }
            accessibilityRole="tab"
            accessibilityState={{ selected: isSelected }}
            key={route.key}
            onPress={() => onNavigate(route.key)}
            style={[styles.tab, isSelected && styles.selectedTab]}
            testID={`nav-${route.key}`}
          >
            <View style={styles.markRow}>
              <NavMark route={route.key} selected={isSelected} />
              {route.key === 'chat' && unreadCount > 0 ? (
                <Text style={styles.unreadBadge} testID="chat-unread-badge">
                  {unreadCount > 99 ? '99+' : unreadCount}
                </Text>
              ) : null}
            </View>
            <Text
              numberOfLines={1}
              style={[styles.tabLabel, isSelected && styles.selectedTabLabel]}
            >
              {label}
            </Text>
            <View style={[styles.tabBar, isSelected && styles.tabBarSelected]} />
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'space-between',
    paddingBottom: 6,
    paddingHorizontal: 24,
    paddingTop: 10,
  },
  brand: { alignItems: 'flex-end', flexDirection: 'row', gap: 3 },
  wordmark: {
    color: COLORS.ink,
    fontFamily: FONTS.display,
    fontSize: 27,
    letterSpacing: -0.3,
    lineHeight: 32,
  },
  brandDot: {
    backgroundColor: COLORS.accent,
    borderRadius: 3,
    height: 6,
    marginBottom: 8,
    width: 6,
  },
  headerRight: {
    alignItems: 'center',
    flexDirection: 'row',
    flexShrink: 1,
    gap: 6,
    justifyContent: 'flex-end',
  },
  demoBadge: {
    borderColor: COLORS.line,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  demoBadgeText: {
    color: COLORS.muted,
    fontFamily: FONTS.sansMedium,
    fontSize: 10,
    letterSpacing: 1.4,
  },
  navigation: {
    backgroundColor: COLORS.deep,
    borderTopColor: COLORS.line,
    borderTopWidth: 1,
    flexDirection: 'row',
    gap: 2,
    minHeight: 68,
    paddingHorizontal: 6,
    paddingTop: 8,
    paddingBottom: 6,
  },
  tab: {
    alignItems: 'center',
    borderRadius: 6,
    flex: 1,
    gap: 4,
    justifyContent: 'center',
    minHeight: 54,
    minWidth: 0,
    paddingHorizontal: 1,
    paddingVertical: 6,
  },
  selectedTab: {},
  markRow: { alignItems: 'center', flexDirection: 'row', gap: 3, height: 20 },
  markBox: { alignItems: 'center', height: 18, justifyContent: 'center', width: 20 },
  homeRoof: {
    borderBottomWidth: 6,
    borderLeftColor: 'transparent',
    borderLeftWidth: 8,
    borderRightColor: 'transparent',
    borderRightWidth: 8,
    height: 0,
    width: 0,
  },
  homeBody: { borderTopWidth: 0, borderWidth: 1.5, height: 8, width: 12 },
  ring: {
    alignItems: 'center',
    borderRadius: 8,
    borderWidth: 1.5,
    height: 16,
    justifyContent: 'center',
    width: 16,
  },
  dot: { borderRadius: 2.5, height: 5, width: 5 },
  lines: { alignItems: 'flex-start', gap: 3, paddingLeft: 2 },
  line: { borderRadius: 1, height: 1.5 },
  box: { alignItems: 'stretch', borderWidth: 1.5, height: 14, width: 16 },
  boxLid: { height: 1.5, marginTop: 3 },
  gear: {
    alignItems: 'center',
    borderRadius: 3,
    borderStyle: 'dashed',
    borderWidth: 1.5,
    height: 16,
    justifyContent: 'center',
    width: 16,
  },
  gearHub: { borderRadius: 3, borderWidth: 1.5, height: 6, width: 6 },
  tabLabel: { color: COLORS.faint, fontFamily: FONTS.sansMedium, fontSize: 10.5, letterSpacing: 0.2 },
  selectedTabLabel: { color: COLORS.ink, fontFamily: FONTS.sansSemiBold },
  tabBar: { borderRadius: 2, height: 4, width: 4 },
  tabBarSelected: { backgroundColor: COLORS.accent },
  unreadBadge: {
    backgroundColor: COLORS.accent,
    borderRadius: 9,
    color: COLORS.accentInk,
    fontSize: 10,
    fontWeight: '800',
    minWidth: 18,
    overflow: 'hidden',
    paddingHorizontal: 4,
    textAlign: 'center',
  },
});
