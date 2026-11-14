import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';

import { useRealAccount } from '../auth/RealAccountProvider';
import { createRealAccountVideoRuntimeClient } from '../capture/real-account-video-runtime';
import { userMessage } from '../domain/user-message';
import type { Push } from './use-group-navigation';
import type { GroupContextRefs } from './use-group-context-refs';
import type { RealGroup } from './real-group-model';

/**
 * The media client for the current transfer mode, the photo/video choice, and
 * opening the camera once the server has said how uploads should travel.
 */
export function useGroupCapture({
  group,
  topKind,
  refs,
  setMessage,
  setMenuOpen,
  pushScreen,
}: {
  group: RealGroup | null;
  topKind: Push['kind'] | undefined;
  refs: GroupContextRefs;
  setMessage: Dispatch<SetStateAction<string | null>>;
  setMenuOpen: Dispatch<SetStateAction<boolean>>;
  pushScreen: (next: Push) => void;
}) {
  const auth = useRealAccount();
  const { groupContextVersionRef, selectedGroupIdRef, captureMountedRef } = refs;
  const [transferMode, setTransferMode] = useState<'server' | 'direct'>('server');
  const mediaClient = useMemo(
    () => createRealAccountVideoRuntimeClient(auth.authenticatedRequest, { transferMode }),
    [auth.authenticatedRequest, transferMode],
  );
  const [captureMode, setCaptureMode] = useState<'photo' | 'video'>('photo');
  const [capturePending, setCapturePending] = useState(false);
  const captureRequest = useRef(0);
  const captureAccount = useRef(auth.session?.account.id);

  useEffect(() => {
    captureMountedRef.current = true;
    return () => {
      captureMountedRef.current = false;
      captureRequest.current += 1;
    };
  }, [captureMountedRef]);
  useEffect(() => {
    captureAccount.current = auth.session?.account.id;
  }, [auth.session?.account.id]);
  useEffect(() => () => mediaClient.dispose(), [mediaClient]);
  useEffect(() => {
    if (topKind !== 'capture') mediaClient.cancelDirectTransfers();
    return () => mediaClient.cancelDirectTransfers();
  }, [mediaClient, topKind, group?.group.id, auth.session?.account.id]);

  const openCapture = async () => {
    if (!group) return;
    const request = ++captureRequest.current;
    const context = groupContextVersionRef.current;
    const groupId = group.group.id;
    const accountId = auth.session?.account.id;
    setCapturePending(true);
    setMessage(null);
    try {
      const response = await auth.authenticatedRequest('/real/media/config?uploadProtocol=2');
      let mode: 'server' | 'direct' = 'server';
      if (response.status !== 404) {
        if (!response.ok)
          throw new Error(
            'Capture settings are unavailable. Reconnect or sign in again, then retry.',
          );
        const config = (await response.json()) as { directTransfer?: unknown };
        if (typeof config.directTransfer !== 'boolean')
          throw new Error('Capture settings could not be verified. Retry when connected.');
        mode = config.directTransfer ? 'direct' : 'server';
      }
      if (
        !captureMountedRef.current ||
        request !== captureRequest.current ||
        context !== groupContextVersionRef.current ||
        selectedGroupIdRef.current !== groupId ||
        captureAccount.current !== accountId
      )
        return;
      setTransferMode(mode);
      setMenuOpen(false);
      pushScreen({ kind: 'capture' });
    } catch (error) {
      if (
        captureMountedRef.current &&
        request === captureRequest.current &&
        context === groupContextVersionRef.current
      )
        setMessage(userMessage(error, 'Capture settings are unavailable. Retry when connected.'));
    } finally {
      if (captureMountedRef.current && request === captureRequest.current) setCapturePending(false);
    }
  };

  return {
    mediaClient,
    transferMode,
    captureMode,
    setCaptureMode,
    capturePending,
    openCapture,
  };
}
