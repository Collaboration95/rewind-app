import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { LocalRuntimeError, type RuntimeClient } from '../runtime/local-runtime-client';
import { ContributionLedger, type ContributionLedgerView } from './ContributionLedger';
import type { ContributionLedgerPage } from '../domain/contributions';

type LedgerPageLoader = (options?: { cursor?: string }) => Promise<ContributionLedgerPage>;

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
  loadPage,
  onPageLoaded,
  sessionId,
  groupId,
  memberId,
  cycleId,
  render,
}: {
  render?: (view: ContributionLedgerView, retry: () => void) => ReactNode;
  client?: RuntimeClient;
  loadPage?: LedgerPageLoader;
  onPageLoaded?: (page: ContributionLedgerPage | null) => void;
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
  const readPage = useCallback(
    (options?: { cursor?: string }) => {
      if (loadPage) return loadPage(options);
      if (!client?.getContributionLedger) throw new Error('Contribution ledger unavailable.');
      return options
        ? client.getContributionLedger(sessionId, groupId, options)
        : client.getContributionLedger(sessionId, groupId);
    },
    [client, groupId, loadPage, sessionId],
  );

  useEffect(() => {
    const request = ++generation.current;
    pendingCursor.current = null;
    void Promise.resolve()
      .then(() => {
        if (request !== generation.current) return null;
        onPageLoaded?.(null);
        return readPage();
      })
      .then(
        (page) => {
          if (request !== generation.current) return;
          if (!page) return;
          const valid = page.cycleId === cycleId && page.memberId === memberId;
          setScoped({
            scopeKey,
            view: valid ? { status: 'ready', page } : { status: 'error' },
          });
          onPageLoaded?.(valid ? page : null);
        },
        (error: unknown) => {
          if (request === generation.current) {
            onPageLoaded?.(null);
            setScoped({ scopeKey, view: { status: denied(error) ? 'denied' : 'error' } });
          }
        },
      );
    return () => {
      generation.current += 1;
    };
  }, [readPage, memberId, cycleId, retryAttempt, scopeKey, onPageLoaded]);

  const loadMore = () => {
    if (
      view.status !== 'ready' ||
      view.loadingMore ||
      (!loadPage && !client?.getContributionLedger)
    )
      return;
    const { page } = view;
    const cursor = page.pagination.nextCursor;
    if (!page.pagination.hasMore || !cursor || pendingCursor.current === cursor) return;
    const request = generation.current;
    pendingCursor.current = cursor;
    setScoped({ scopeKey, view: { status: 'ready', page, loadingMore: true } });
    void Promise.resolve()
      .then(() => readPage({ cursor }))
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

  const retry = () => setRetryAttempt((attempt) => attempt + 1);
  if (render) return render(view, retry);
  return <ContributionLedger view={view} onRetry={retry} onLoadMore={loadMore} />;
}
