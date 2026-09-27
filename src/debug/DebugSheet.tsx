import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useI18n } from '../i18n/LanguageProvider';
import { COLORS } from '../theme';
import { ActionButton, Eyebrow, Micro } from '../ui/kit';
import { useDebug } from './DebugProvider';
import {
  DEBUG_SCENARIO_HINTS,
  DEBUG_SCENARIO_LABELS,
  DEBUG_SCREEN_LABELS,
  DEBUG_SCREEN_ORDER,
  DEBUG_SCREENS,
  type DebugScreen,
} from './scenarios';

/** Header chip that shows the forced state of the visible screen. */
export function DebugChip({ screen }: { screen: DebugScreen }) {
  const { t } = useI18n();
  const { enabled, openSheet, runtime, scenarios } = useDebug();
  if (!enabled) return null;
  const scenario = scenarios[screen] ?? 'live';
  const label = `${t('DEBUG')} · ${t(DEBUG_SCENARIO_LABELS[scenario] ?? scenario)}${
    runtime === 'offline' ? ` · ${t('Offline')}` : ''
  }`;
  return (
    <Pressable
      accessibilityHint={t('Opens the debug state picker for this screen')}
      accessibilityLabel={t('Debug state: {label}', { label })}
      accessibilityRole="button"
      onPress={() => openSheet(screen)}
      style={styles.chip}
      testID="debug-chip"
    >
      <Text numberOfLines={1} style={styles.chipText}>
        {label}
      </Text>
    </Pressable>
  );
}

export function DebugSheet({
  currentScreen,
  onNavigate,
}: {
  currentScreen: DebugScreen;
  onNavigate: (screen: DebugScreen) => void;
}) {
  const { t } = useI18n();
  const {
    clearScenarios,
    enabled,
    runtime,
    scenarios,
    setRuntime,
    setScenario,
    setSheetOpen,
    sheetOpen,
    sheetScreen,
  } = useDebug();
  const [screenChoice, setScreen] = useState<DebugScreen | null>(null);
  const screen = screenChoice ?? sheetScreen ?? currentScreen;

  if (!enabled) return null;
  const active = scenarios[screen] ?? 'live';
  const close = () => {
    setScreen(null);
    setSheetOpen(false);
  };

  return (
    <Modal
      accessibilityLabel={t('Debug state picker')}
      animationType="slide"
      onRequestClose={close}
      transparent
      visible={sheetOpen}
    >
      <View style={styles.backdrop}>
        <View style={styles.sheet} testID="debug-sheet">
          <View style={styles.sheetHeader}>
            <View style={styles.sheetTitleBlock}>
              <Eyebrow>{t('DEBUG MODE')}</Eyebrow>
              <Text accessibilityRole="header" style={styles.sheetTitle}>
                {t('Preview screen states')}
              </Text>
            </View>
            <ActionButton label={t('Close')} onPress={close} testID="debug-close" />
          </View>
          <ScrollView contentContainerStyle={styles.sheetBody}>
            <Text style={styles.sectionLabel}>{t('Screen')}</Text>
            <View style={styles.chips}>
              {DEBUG_SCREEN_ORDER.map((key) => {
                const forced = scenarios[key] && scenarios[key] !== 'live';
                return (
                  <Pressable
                    accessibilityRole="radio"
                    accessibilityState={{ checked: key === screen, selected: key === screen }}
                    aria-checked={key === screen}
                    key={key}
                    onPress={() => setScreen(key)}
                    style={[styles.option, key === screen && styles.optionSelected]}
                    testID={`debug-screen-${key}`}
                  >
                    <Text style={styles.optionText}>
                      {t(DEBUG_SCREEN_LABELS[key])}
                      {forced ? ' •' : ''}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            {screen !== currentScreen ? (
              <ActionButton
                label={t('Go to {screen}', { screen: t(DEBUG_SCREEN_LABELS[screen]) })}
                onPress={() => {
                  onNavigate(screen);
                  close();
                }}
                testID="debug-go-to-screen"
              />
            ) : null}

            <Text style={styles.sectionLabel}>{t('State')}</Text>
            <View style={styles.list}>
              {(DEBUG_SCREENS[screen] as readonly string[]).map((scenario) => {
                const selected = scenario === active;
                const hint = DEBUG_SCENARIO_HINTS[screen]?.[scenario];
                return (
                  <Pressable
                    accessibilityRole="radio"
                    accessibilityState={{ checked: selected, selected }}
                    aria-checked={selected}
                    key={scenario}
                    onPress={() => setScenario(screen, scenario)}
                    style={[styles.row, selected && styles.optionSelected]}
                    testID={`debug-state-${screen}-${scenario}`}
                  >
                    <Text style={styles.rowMark}>{selected ? '●' : '○'}</Text>
                    <View style={styles.rowText}>
                      <Text style={styles.optionText}>
                        {t(DEBUG_SCENARIO_LABELS[scenario] ?? scenario)}
                      </Text>
                      {hint ? <Micro>{t(hint)}</Micro> : null}
                    </View>
                  </Pressable>
                );
              })}
            </View>

            <Text style={styles.sectionLabel}>{t('Local runtime')}</Text>
            <View style={styles.chips}>
              {(['live', 'offline'] as const).map((mode) => (
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{ checked: runtime === mode, selected: runtime === mode }}
                  aria-checked={runtime === mode}
                  key={mode}
                  onPress={() => setRuntime(mode)}
                  style={[styles.option, runtime === mode && styles.optionSelected]}
                  testID={`debug-runtime-${mode}`}
                >
                  <Text style={styles.optionText}>
                    {mode === 'live' ? t('As configured') : t('Simulate offline')}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Micro>
              {t(
                'Forced states are local previews. They never change sessions, groups, contributions or media.',
              )}
            </Micro>
            <ActionButton
              label={t('Reset every screen to live data')}
              onPress={clearScenarios}
              testID="debug-reset-all"
            />
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  chip: {
    borderColor: COLORS.accent,
    borderRadius: 999,
    borderStyle: 'dashed',
    borderWidth: 1,
    flexShrink: 1,
    minHeight: 30,
    justifyContent: 'center',
    paddingHorizontal: 9,
  },
  chipText: { color: COLORS.accent, fontSize: 10, fontWeight: '800', letterSpacing: 0.4 },
  backdrop: {
    backgroundColor: 'rgba(29, 27, 30, 0.72)',
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheet: {
    alignSelf: 'center',
    backgroundColor: COLORS.background,
    borderColor: COLORS.line,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: 1,
    maxHeight: '86%',
    maxWidth: 480,
    width: '100%',
  },
  sheetHeader: {
    alignItems: 'center',
    borderBottomColor: COLORS.line,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
    padding: 18,
  },
  sheetTitleBlock: { flex: 1, gap: 4 },
  sheetTitle: { color: COLORS.ink, fontSize: 19, fontWeight: '700' },
  sheetBody: { gap: 12, padding: 18, paddingBottom: 36 },
  sectionLabel: { color: COLORS.edge, fontSize: 12, fontWeight: '700', marginTop: 6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  option: {
    borderColor: COLORS.line,
    borderRadius: 8,
    borderWidth: 1,
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  optionSelected: { backgroundColor: COLORS.paper, borderColor: COLORS.accent },
  optionText: { color: COLORS.ink, fontSize: 14, fontWeight: '600' },
  list: { gap: 6 },
  row: {
    alignItems: 'center',
    borderColor: COLORS.line,
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 10,
    minHeight: 48,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  rowMark: { color: COLORS.accent, fontSize: 14, width: 16 },
  rowText: { flex: 1, gap: 2 },
});
