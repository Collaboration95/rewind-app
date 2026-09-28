import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { CapsuleSummary, type HomeDebugScenario } from '../capsule/CapsuleSummary';
import type { ContributionStatus } from '../capture/contribution-status';
import { ContributionLedgerSection } from '../contributions/ContributionLedgerSection';
import type { RevealEducationState } from '../domain/reveal-education';
import { useI18n } from '../i18n/LanguageProvider';
import type { RuntimeClient } from '../runtime/local-runtime-client';
import { useDemoSession } from '../session/DemoSessionProvider';
import { COLORS, FONTS, SPACE } from '../theme';
import { Micro, Panel, kitStyles } from '../ui/kit';

export function HomeScreen({
  clock,
  contributionStatusOverride,
  debugScenario,
  ledgerScope,
  onAddMoment,
  onOpenArchive,
  onOpenSettings,
  revealState,
  runtimeClient,
  stillSaved,
}: {
  clock: () => number;
  contributionStatusOverride?: ContributionStatus | null;
  debugScenario: HomeDebugScenario | null;
  ledgerScope: { sessionId: string; groupId: string; memberId: string; cycleId: string } | null;
  onAddMoment: () => void;
  onOpenArchive: () => void;
  onOpenSettings: () => void;
  revealState: RevealEducationState;
  runtimeClient: RuntimeClient | null;
  stillSaved: boolean;
}) {
  const { language, t } = useI18n();
  const { session } = useDemoSession();
  const now = new Date(clock());
  const today =
    language === 'zh'
      ? now.toLocaleDateString('zh-CN', { day: 'numeric', month: 'long', weekday: 'short' })
      : `${now.toLocaleDateString('en-US', { weekday: 'short' })} ${now.getDate()} ${now.toLocaleDateString('en-US', { month: 'short' })}`;
  return (
    <ScrollView
      contentContainerStyle={[kitStyles.content, styles.content]}
      showsVerticalScrollIndicator={false}
      style={kitStyles.scroll}
      testID="home-scroll"
    >
      <View style={styles.meta}>
        <Text style={[styles.date, language === 'zh' && styles.dateZh]}>
          {language === 'zh' ? today : today.toUpperCase()}
        </Text>
        {session ? (
          <View
            accessible
            accessibilityLabel={`${session.actor.displayName}, ${t('synthetic member')}`}
            style={styles.actor}
          >
            <Text style={styles.actorText}>
              {session.actor.displayName} · {t('synthetic member')}
            </Text>
            <View style={styles.actorAvatar}>
              <Text style={styles.actorInitial}>
                {session.actor.displayName.slice(0, 1).toUpperCase()}
              </Text>
            </View>
          </View>
        ) : null}
      </View>

      <CapsuleSummary
        afterContribution={
          stillSaved ? (
            <Panel
              body={t('Saved on this device. No clip uploaded; allowance unchanged.')}
              testID="home-still-saved"
              title={t('Still saved locally')}
            />
          ) : null
        }
        clock={clock}
        contributionStatusOverride={contributionStatusOverride}
        debugScenario={debugScenario}
        onAddMoment={onAddMoment}
        onOpenArchive={onOpenArchive}
        onOpenSettings={onOpenSettings}
        revealState={revealState}
      />

      {runtimeClient?.getContributionLedger && ledgerScope ? (
        <ContributionLedgerSection client={runtimeClient} {...ledgerScope} />
      ) : null}

      <Micro testID="home-content-end">
        {runtimeClient
          ? t('Local runtime mode · Demo data only.')
          : t('Offline Demo fixture · Demo data only.')}
      </Micro>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { gap: 18, paddingHorizontal: SPACE.page, paddingTop: 14 },
  meta: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  date: { color: COLORS.edge, fontFamily: FONTS.sansSemiBold, fontSize: 10.5, letterSpacing: 1.8 },
  dateZh: { letterSpacing: 0.6 },
  actor: { alignItems: 'center', flexDirection: 'row', flexShrink: 1, gap: 8 },
  actorText: { color: COLORS.faint, flexShrink: 1, fontFamily: FONTS.sans, fontSize: 12 },
  actorAvatar: {
    alignItems: 'center',
    backgroundColor: COLORS.paper,
    borderColor: COLORS.line,
    borderRadius: 13,
    borderWidth: 1,
    height: 26,
    justifyContent: 'center',
    width: 26,
  },
  actorInitial: { color: COLORS.ink, fontFamily: FONTS.sansSemiBold, fontSize: 11 },
});
