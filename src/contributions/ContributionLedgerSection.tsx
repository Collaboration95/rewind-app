import { useEffect, useRef, useState } from 'react';

import { LocalRuntimeError, type RuntimeClient } from '../runtime/local-runtime-client';
import { ContributionLedger, type ContributionLedgerView } from './ContributionLedger';

function denied(error: unknown): boolean {
  return error instanceof LocalRuntimeError && (error.status === 401 || error.status === 403);
}

interface ScopedView {
  scopeKey: string;
  view: ContributionLedgerView;
}

/** Loads only the signed-in member's current-cycle metadata. The Home route
 * unmounts this section when the user navigates away, so returning after a
 * capture or correction starts a fresh read. */
export function ContributionLedgerSection({
  client,
  sessionId,
  groupId,
  memberId,
  cycleId,
}: {
  client: RuntimeClient;
  sessionId: string;
  groupId: string;
  memberId: string;
  cycleId: string;
}) {
  const [retryAttempt, setRetryAttempt] = useState(0);
  const scopeKey = `${sessionId}\0${groupId}\0${memberId}\0${cycleId}\0${retryAttempt}`;
  const [scoped, setScoped] = useState<ScopedView>({ scopeKey, view: { status: 'loading' } });
  const view: ContributionLedgerView =
    scoped.scopeKey === scopeKey ? scoped.view : { status: 'loading' };
  const generation = useRef(0);
  const pendingCursor = useRef<string | null>(null);

  useEffect(() => {
    const request = ++generation.current;
    pendingCursor.current = null;
    void Promise.resolve()
      .then(() => {
        if (request !== generation.current) return null;
        if (!client.getContributionLedger) throw new Error('Contribution ledger unavailable.');
        return client.getContributionLedger(sessionId, groupId);
      })
      .then(
        (page) => {
          if (request !== generation.current) return;
          if (!page) return;
          setScoped({
            scopeKey,
            view:
              page.cycleId === cycleId && page.memberId === memberId
                ? { status: 'ready', page }
                : { status: 'error' },
          });
        },
        (error: unknown) => {
          if (request === generation.current) {
            setScoped({ scopeKey, view: { status: denied(error) ? 'denied' : 'error' } });
          }
        },
      );
    return () => {
      generation.current += 1;
    };
  }, [client, sessionId, groupId, memberId, cycleId, retryAttempt, scopeKey]);

  const loadMore = () => {
    if (view.status !== 'ready' || view.loadingMore || !client.getContributionLedger) return;
    const { page } = view;
    const cursor = page.pagination.nextCursor;
    if (!page.pagination.hasMore || !cursor || pendingCursor.current === cursor) return;
    const request = generation.current;
    pendingCursor.current = cursor;
    setScoped({ scopeKey, view: { status: 'ready', page, loadingMore: true } });
    void client
      .getContributionLedger(sessionId, groupId, { cursor })
      .then(
        (next) => {
          if (request !== generation.current) return;
          if (next.cycleId !== cycleId || next.memberId !== memberId) {
            setScoped({ scopeKey, view: { status: 'error' } });
            return;
          }
          setScoped((current) => {
            if (current.scopeKey !== scopeKey || current.view.status !== 'ready') return current;
            const seen = new Set(current.view.page.entries.map((entry) => entry.contributionId));
            return {
              scopeKey,
              view: {
                status: 'ready',
                page: {
                  ...next,
                  entries: [
                    ...current.view.page.entries,
                    ...next.entries.filter((entry) => !seen.has(entry.contributionId)),
                  ],
                },
              },
            };
          });
        },
        (error: unknown) => {
          if (request !== generation.current) return;
          if (denied(error)) {
            setScoped({ scopeKey, view: { status: 'denied' } });
          } else {
            setScoped((current) =>
              current.scopeKey === scopeKey && current.view.status === 'ready'
                ? {
                    scopeKey,
                    view: { status: 'ready', page: current.view.page, loadMoreError: true },
                  }
                : current,
            );
          }
        },
      )
      .finally(() => {
        if (request === generation.current) pendingCursor.current = null;
      });
  };

  return (
    <ContributionLedger
      view={view}
      onRetry={() => setRetryAttempt((attempt) => attempt + 1)}
      onLoadMore={loadMore}
    />
  );
}
