import { useEffect, useState } from 'react';

import { useRealAccount } from '../auth/RealAccountProvider';
import { listBlocked } from '../real/safety';

/**
 * Blocked people are fetched when Members opens; the server already hides
 * their messages and moments everywhere else.
 */
export function useBlockedMembers(membersOpen: boolean) {
  const auth = useRealAccount();
  const [blocked, setBlocked] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!membersOpen) return;
    let active = true;
    void listBlocked(auth.authenticatedRequest)
      .then((ids) => {
        if (active) setBlocked(ids);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [auth.authenticatedRequest, membersOpen]);
  return [blocked, setBlocked] as const;
}
