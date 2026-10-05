import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type {
  RealAccountArchiveClient,
  RealArchiveFilm,
  RealArchivePage,
} from '../auth/real-account-client';
import { Icon } from '../ui/Icon';
import { Button, Glass, Glow, GlowLow, ProgressBar, SectionLabel, rw } from '../ui/primitives';
import { FONT, LAYOUT, WARM, serif } from '../ui/tokens';
import { plural, type HomeRelease } from './home-model';

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/** R1–R6: this cycle's step on top, then every released film. */
export function ArchiveScreen({
  client,
  groupId,
  currentCycleId,
  prompt,
  daysLeft,
  releases,
  header,
  topInset,
  bottomInset,
  onOpenFilm,
}: {
  client: RealAccountArchiveClient | null;
  groupId: string;
  currentCycleId: string;
  prompt: string;
  daysLeft: number;
  releases: HomeRelease[];
  header: ReactNode;
  topInset: number;
  bottomInset: number;
  onOpenFilm: (cycleId: string, label: string) => void;
}) {
  const [page, setPage] = useState<RealArchivePage | null>(null);
  const [failed, setFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    if (!client) {
      setFailed(true);
      return;
    }
    try {
      setPage(await client.getArchivePage(groupId, { limit: 20 }));
    } catch {
      setFailed(true);
    }
  }, [client, groupId]);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const loadMore = async () => {
    if (!client || !page?.pagination.hasMoreFilms || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await client.getArchivePage(groupId, {
        filmCursor: page.pagination.filmCursor,
        limit: 20,
      });
      setPage((current) =>
        current
          ? {
              archive: {
                films: [
                  ...current.archive.films,
                  ...next.archive.films.filter(
                    (film) => !current.archive.films.some((known) => known.id === film.id),
                  ),
                ],
                clips: current.archive.clips,
              },
              pagination: next.pagination,
            }
          : next,
      );
    } catch {
      setFailed(true);
    } finally {
      setLoadingMore(false);
    }
  };

  const previous = releases.filter((release) => release.cycleId !== currentCycleId);
  const premiere = previous.find((release) => release.state === 'premiere');
  const developing = previous.find((release) => release.state === 'processing');
  const delayed = previous.find((release) => release.state === 'delayed');
  const films = (page?.archive.films ?? []).filter((film) => film.cycleId !== premiere?.cycleId);
  const count = films.length + (premiere ? 1 : 0);

  let now: ReactNode;
  if (premiere)
    now = (
      <Glass style={styles.prem} testID="real-archive-premiere">
        <Pressable
          accessibilityLabel="Play the film"
          onPress={() => onOpenFilm(premiere.cycleId, 'Premiere')}
          style={styles.poster}
        >
          {[0, 1, 2, 3].map((index) => (
            <View
              key={index}
              style={[styles.frame, { opacity: 0.55 + index * 0.1 }]}
              {...rw('bokeh')}
            />
          ))}
          <View style={styles.play} {...rw('primary')}>
            <Icon color={WARM.peachInk} filled name="play" size={24} />
          </View>
        </Pressable>
        <Text style={styles.kicker}>Premiere</Text>
        <Text style={styles.premTitle}>Your film is here</Text>
        <Text style={styles.meta}>Cycle ended {shortDate(premiere.endsAt)}</Text>
        <Button
          icon="play"
          label="Play"
          onPress={() => onOpenFilm(premiere.cycleId, 'Premiere')}
          testID="real-archive-play"
          variant="primary"
        />
      </Glass>
    );
  else if (developing || delayed)
    now = (
      <Glass role="status" style={styles.now} testID="real-archive-now">
        <View style={styles.ico}>
          <Icon name="clock" size={20} />
        </View>
        <View style={styles.nowText}>
          <Text style={styles.nowTitle}>
            {delayed ? 'Taking a little longer' : 'Your film is developing'}
          </Text>
          <Text style={styles.nowNote}>
            {delayed
              ? 'Nothing to play yet. Everyone hears when it’s ready.'
              : 'You can watch it once it’s out.'}
          </Text>
          <ProgressBar slow={Boolean(delayed)} width="100%" />
        </View>
      </Glass>
    );
  else
    now = (
      <Glass role="status" style={styles.now} testID="real-archive-now">
        <View style={styles.ico}>
          <Icon name="lock" size={20} />
        </View>
        <View style={styles.nowText}>
          <Text style={styles.nowTitle}>This cycle · collecting</Text>
          <Text style={styles.nowNote}>
            {prompt} · opens in {plural(daysLeft, 'day')} · sealed until then
          </Text>
        </View>
      </Glass>
    );

  return (
    <View style={styles.fill}>
      <Glow />
      <GlowLow />
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: topInset, paddingBottom: bottomInset },
        ]}
        showsVerticalScrollIndicator={false}
        style={styles.fill}
        testID="real-archive"
      >
        {header}
        <View style={styles.head}>
          <Text accessibilityRole="header" style={styles.h1} testID="route-heading-archive">
            Archive
          </Text>
          {failed ? null : (
            <Text style={styles.sub}>
              {page
                ? count
                  ? `${plural(count, 'film')} so far`
                  : 'Nothing here yet.'
                : 'Loading…'}
            </Text>
          )}
        </View>
        {failed ? (
          <View accessibilityRole="alert" style={styles.state} testID="real-archive-unavailable">
            <Text accessibilityRole="header" style={styles.stateTitle}>
              Couldn’t load the archive
            </Text>
            <Text style={styles.stateBody}>Check your connection and try again.</Text>
            <Button
              label="Try again"
              onPress={() => void load()}
              style={styles.stateButton}
              testID="real-archive-retry"
            />
          </View>
        ) : (
          <>
            {now}
            {films.length ? (
              <>
                <SectionLabel>Earlier films</SectionLabel>
                <View style={styles.list}>
                  {films.map((film) => (
                    <FilmCard
                      film={film}
                      key={film.id}
                      onOpen={() =>
                        onOpenFilm(film.cycleId, `Released ${shortDate(film.publishedAt)}`)
                      }
                    />
                  ))}
                </View>
                {page?.pagination.hasMoreFilms ? (
                  <Button
                    busy={loadingMore}
                    busyLabel="Loading…"
                    label="Show older films"
                    onPress={() => void loadMore()}
                    style={styles.older}
                    testID="real-archive-older"
                  />
                ) : null}
              </>
            ) : page && !premiere ? (
              <View style={styles.first} testID="real-archive-first">
                <Text accessibilityRole="header" style={styles.firstTitle}>
                  Your first film
                </Text>
                <Text style={styles.stateBody}>
                  It opens when this cycle ends. Every film stays here to watch again.
                </Text>
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function FilmCard({ film, onOpen }: { film: RealArchiveFilm; onOpen: () => void }) {
  const moments = film.segments?.filter((segment) => !segment.hidden).length;
  const info = (
    <View style={styles.info}>
      <Text style={styles.kicker}>Released {shortDate(film.publishedAt)}</Text>
      <Text style={styles.filmTitle}>Group film</Text>
      {moments ? <Text style={styles.meta}>{plural(moments, 'moment')}</Text> : null}
    </View>
  );
  return (
    <Glass style={styles.film} testID={`real-archive-film-${film.id}`}>
      <Pressable
        accessibilityLabel={`Play the film released ${shortDate(film.publishedAt)}`}
        accessibilityRole="button"
        disabled={!film.playbackUrl}
        onPress={onOpen}
        style={styles.thumb}
        {...rw('bokeh')}
      >
        <Icon color="#fff" filled name="play" size={26} />
      </Pressable>
      <View style={styles.info}>
        {info}
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            disabled={!film.playbackUrl}
            onPress={onOpen}
            style={styles.pill}
            testID={`real-archive-watch-${film.id}`}
          >
            <Icon filled name="play" size={14} />
            <Text style={styles.pillText}>Watch</Text>
          </Pressable>
        </View>
      </View>
    </Glass>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: {
    alignSelf: 'center',
    maxWidth: LAYOUT.maxWidth,
    paddingHorizontal: LAYOUT.gutter,
    width: '100%',
  },
  head: { marginBottom: 18, marginHorizontal: 6, marginTop: 4 },
  h1: { color: WARM.ink, letterSpacing: -0.3, ...serif(34) },
  sub: { color: WARM.muted, fontFamily: FONT.body, fontSize: 13.5, marginTop: 6 },
  now: {
    alignItems: 'center',
    borderRadius: 24,
    flexDirection: 'row',
    gap: 14,
    paddingLeft: 14,
    paddingRight: 18,
    paddingVertical: 14,
  },
  ico: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.6)',
    borderRadius: 21,
    height: 42,
    justifyContent: 'center',
    width: 42,
  },
  nowText: { flex: 1, gap: 3, minWidth: 0 },
  nowTitle: { color: WARM.ink, fontFamily: FONT.body, fontSize: 15, fontWeight: '600' },
  nowNote: { color: WARM.muted, fontFamily: FONT.body, fontSize: 13, lineHeight: 18 },
  prem: { borderRadius: 30, padding: 10, paddingBottom: 14 },
  poster: {
    backgroundColor: '#1c120c',
    borderRadius: 22,
    flexDirection: 'row',
    gap: 3,
    height: 156,
    overflow: 'hidden',
  },
  frame: { backgroundColor: '#7a3a2a', flex: 1 },
  play: {
    alignItems: 'center',
    backgroundColor: '#ffb784',
    borderRadius: 29,
    height: 58,
    justifyContent: 'center',
    left: '50%',
    marginLeft: -29,
    marginTop: -29,
    paddingLeft: 3,
    position: 'absolute',
    top: '50%',
    width: 58,
  },
  kicker: {
    color: WARM.muted,
    fontFamily: FONT.body,
    fontSize: 11.5,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  premTitle: { color: WARM.ink, marginBottom: 4, marginHorizontal: 8, marginTop: 6, ...serif(22) },
  meta: {
    color: WARM.muted,
    fontFamily: FONT.body,
    fontSize: 13,
    marginBottom: 14,
    marginHorizontal: 8,
  },
  list: { gap: 12 },
  film: { borderRadius: 24, flexDirection: 'row', gap: 14, padding: 12 },
  thumb: {
    alignItems: 'center',
    backgroundColor: '#7a3a2a',
    borderRadius: 16,
    height: 112,
    justifyContent: 'center',
    width: 72,
  },
  info: { flex: 1, gap: 4, minWidth: 0, paddingTop: 2 },
  filmTitle: { color: WARM.ink, ...serif(17) },
  actions: { flexDirection: 'row', gap: 6, marginTop: 'auto', paddingTop: 8 },
  pill: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.7)',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 5,
    minHeight: 44,
    paddingLeft: 10,
    paddingRight: 12,
  },
  pillText: { color: WARM.ink, fontFamily: FONT.body, fontSize: 12.5, fontWeight: '600' },
  older: { marginTop: 14 },
  state: { alignItems: 'center', gap: 6, marginTop: 40 },
  stateTitle: { color: WARM.ink, textAlign: 'center', ...serif(24) },
  stateBody: {
    color: WARM.muted,
    fontFamily: FONT.body,
    fontSize: 14,
    lineHeight: 20,
    maxWidth: 280,
    textAlign: 'center',
  },
  stateButton: { marginTop: 12, paddingHorizontal: 26, width: undefined },
  first: { alignItems: 'center', gap: 6, marginTop: 34 },
  firstTitle: { color: WARM.ink, ...serif(22) },
});
