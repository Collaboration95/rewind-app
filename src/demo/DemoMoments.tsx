import { useCapsule } from '../capsule/CapsuleProvider';
import { ContributionLedgerSection } from '../contributions/ContributionLedgerSection';
import { cycleWeek } from '../real/home-model';
import { MomentsScreen } from '../real/Moments';
import type { RuntimeClient } from '../runtime/local-runtime-client';
import { useDemoSession } from '../session/DemoSessionProvider';

/** Existing Demo correction and processing endpoints, behind the shared M UI. */
export function DemoMoments({
  runtimeClient,
  clock,
  onBack,
  onRetake,
  onReloadCapsule,
}: {
  runtimeClient: RuntimeClient | null;
  clock: () => number;
  onBack: () => void;
  onRetake: () => void;
  onReloadCapsule: () => void;
}) {
  const { session } = useDemoSession();
  const { state } = useCapsule();
  const cycle = state.status === 'ready' ? state.cycle : null;
  if (!session || !cycle) return null;
  const week = cycleWeek(cycle, clock());
  if (!runtimeClient?.getContributionLedger)
    return (
      <MomentsScreen
        page={null}
        error="Server-backed moments are unavailable in this local Demo."
        resetDays={week.resetDays}
        windowStart={week.windowStart}
        onBack={onBack}
        onDelete={async () => {}}
        onRetry={async () => {}}
        onRetake={onRetake}
        onReload={onReloadCapsule}
      />
    );
  return (
    <ContributionLedgerSection
      client={runtimeClient}
      sessionId={session.id}
      groupId={cycle.groupId}
      memberId={session.actor.memberId}
      cycleId={cycle.id}
      allPages
      render={(view, reload) => (
        <MomentsScreen
          page={view.status === 'ready' ? view.page : null}
          error={
            view.status === 'error'
              ? 'Your moments could not be loaded. Try again.'
              : view.status === 'denied'
                ? 'This Demo session cannot access these moments.'
                : null
          }
          resetDays={week.resetDays}
          windowStart={week.windowStart}
          onBack={onBack}
          onReload={reload}
          onRetake={onRetake}
          onDelete={async (entry) => {
            if (!runtimeClient.deleteContribution)
              throw new Error('Deletion is unavailable in this Demo runtime.');
            await runtimeClient.deleteContribution(session.id, cycle.groupId, entry.contributionId);
            reload();
          }}
          onRetry={async (entry) => {
            if (!entry.jobId || !runtimeClient.processClipJob)
              throw new Error('Retry is unavailable in this Demo runtime.');
            await runtimeClient.processClipJob(session.id, cycle.groupId, entry.jobId);
            reload();
          }}
        />
      )}
    />
  );
}
