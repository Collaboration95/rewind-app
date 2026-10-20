import { useRealAccount } from '../auth/RealAccountProvider';
import { CameraCaptureScreen } from '../capture/CameraCaptureScreen';
import { ContributionStatusProvider } from '../capture/contribution-status';
import type { createRealAccountVideoRuntimeClient } from '../capture/real-account-video-runtime';
import { VideoCaptureScreen } from '../capture/VideoCaptureScreen';
import type { ContributionLedgerPage } from '../domain/contributions';
import type { RealGroup } from './real-group-model';
import { submitPhotoContribution } from './photo-submit';

/** The camera or the video recorder for the group, inside its contribution-status scope. */
export function GroupCaptureView({
  group,
  allowance,
  mediaClient,
  captureMode,
  setCaptureMode,
  transferMode,
  loadContributionLedger,
  closeCapture,
}: {
  group: RealGroup;
  allowance: ContributionLedgerPage['allowance'] | null;
  mediaClient: ReturnType<typeof createRealAccountVideoRuntimeClient>;
  captureMode: 'photo' | 'video';
  setCaptureMode: (mode: 'photo' | 'video') => void;
  transferMode: 'server' | 'direct';
  loadContributionLedger: () => Promise<ContributionLedgerPage>;
  closeCapture: () => void;
}) {
  const auth = useRealAccount();
  return (
    <ContributionStatusProvider
      scope={{
        sessionId: 'real-account-session',
        groupId: group.group.id,
        memberId: auth.session?.account.id ?? '',
      }}
      loadStatus={loadContributionLedger}
    >
      {captureMode === 'photo' ? (
        <CameraCaptureScreen
          allowance={allowance}
          groupName={group.group.name}
          onBack={closeCapture}
          onRecordClip={() => setCaptureMode('video')}
          onSubmitPhoto={(metadata, base64, onProgress, replacesContributionId, look) =>
            submitPhotoContribution(
              mediaClient,
              group.group.id,
              metadata,
              base64,
              onProgress,
              replacesContributionId,
              look,
            )
          }
          onDeletePhotoContribution={(contributionId) =>
            mediaClient.deleteContribution('real-account-session', group.group.id, contributionId)
          }
        />
      ) : (
        <VideoCaptureScreen
          allowance={allowance}
          onBack={() => setCaptureMode('photo')}
          onClose={closeCapture}
          realAccount={{
            groupId: group.group.id,
            authenticatedRequest: auth.authenticatedRequest,
            transferMode,
          }}
        />
      )}
    </ContributionStatusProvider>
  );
}
