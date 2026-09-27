import { ScrollView } from 'react-native';

import { CapsuleSummary, type HomeDebugScenario } from '../capsule/CapsuleSummary';
import type { ContributionStatus } from '../capture/contribution-status';
import { ContributionLedgerSection } from '../contributions/ContributionLedgerSection';
import type { RevealEducationState } from '../domain/reveal-education';
import { useI18n } from '../i18n/LanguageProvider';
import type { RuntimeClient } from '../runtime/local-runtime-client';
import { useDemoSession } from '../session/DemoSessionProvider';
import { ActorLine, Micro, Panel, Separator, kitStyles } from '../ui/kit';

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
  const { t } = useI18n();
  const { session } = useDemoSession();
  return (
    <ScrollView
      contentContainerStyle={kitStyles.content}
      showsVerticalScrollIndicator={false}
      style={kitStyles.scroll}
      testID="home-scroll"
    >
      {session ? (
        <ActorLine caption={t('synthetic member')} name={session.actor.displayName} />
      ) : null}

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

      <Separator />
      <Micro testID="home-content-end">
        {runtimeClient
          ? t('Local runtime mode · Demo data only.')
          : t('Offline Demo fixture · Demo data only.')}
      </Micro>
    </ScrollView>
  );
}
