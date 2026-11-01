import { useMemo, useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { useRealAccount } from '../auth/RealAccountProvider';
import { type InviteLinkPayload } from '../invites/deep-links';
import { RealAccountChatScreen } from '../chat/RealAccountChatScreen';
import { useRealChatUnread } from '../chat/real-chat-client';
import { useComposerKeyboard } from '../chat/use-composer-keyboard';
import { createRealAccountArchiveClient } from '../auth/real-account-client';
import { ArchiveScreen } from '../real/Archive';
import { FilmScreen } from '../real/Film';
import { CreateGroupScreen, JoinScreen } from '../real/GroupFlows';
import { HomeBody, HomeState, LoadingState } from '../real/Home';
import {
  cycleWeek,
  filmCountdown,
  homeCards,
  momentDay,
  premiereLeft,
  premiereRelease,
  shutterState,
} from '../real/home-model';
import { MomentsScreen, weekMoments } from '../real/Moments';
import { SettingsScreen } from '../real/Settings';
import { Dock, GroupMenu, ScreenFades, TabColumn, TopBar, type MenuGroup } from '../real/Shell';
import { Glow, rw, useNow, useScreenInsets, useToast } from '../ui/primitives';
import { LAYOUT, WARM } from '../ui/tokens';
import { GroupCaptureView } from './GroupCaptureView';
import { GroupNotices, signOutNoticeFor } from './GroupNotices';
import { displayInviteCode, type RealGroup } from './real-group-model';
import { useBlockedMembers } from './use-blocked-members';
import { useContributionLedger } from './use-contribution-ledger';
import { useGroupCapture } from './use-group-capture';
import { useGroupContextRefs } from './use-group-context-refs';
import { useGroupLoader } from './use-group-loader';
import { useGroupMembershipFlows } from './use-group-membership-flows';
import { useGroupNavigation } from './use-group-navigation';
import { useGroupRefresh } from './use-group-refresh';
import { useGroupReminders, useReminderIntentRouting } from './use-group-reminders';

export { photoContributionStatusForJob } from './photo-submit';

export function RealAccountGroupExperience({
  displayName,
  inviteIntent,
}: {
  displayName: string;
  inviteIntent?: (InviteLinkPayload & { groupId: string }) | null;
  inviteWebOrigin?: string;
}) {
  const auth = useRealAccount();
  const toast = useToast();
  const insets = useScreenInsets();
  const now = useNow();
  const refs = useGroupContextRefs();
  const [group, setGroup] = useState<RealGroup | null>(null);
  const [memberGroups, setMemberGroups] = useState<RealGroup[]>([]);
  const [screen, setScreen] = useState<'loading' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const {
    tab,
    setTab,
    stack,
    setStack,
    top,
    pushScreen,
    popScreen,
    replaceScreen,
    menuOpen,
    setMenuOpen,
    goHome,
  } = useGroupNavigation();
  const chatKeyboard = useComposerKeyboard(tab === 'chat' && !top);
  const [rollKey, setRollKey] = useState(0);
  const [chatUnreadAtOpen, setChatUnreadAtOpen] = useState(0);
  const archiveClient = useMemo(
    () =>
      auth.baseUrl ? createRealAccountArchiveClient(auth.baseUrl, auth.authenticatedRequest) : null,
    [auth.authenticatedRequest, auth.baseUrl],
  );
  const reminders = useGroupReminders({ group, refs });
  const { reminderClient, signOut } = reminders;
  useReminderIntentRouting({ refs, setMessage, setGroup, setScreen, goHome });
  const { mediaClient, transferMode, captureMode, setCaptureMode, capturePending, openCapture } =
    useGroupCapture({ group, topKind: top?.kind, refs, setMessage, setMenuOpen, pushScreen });
  const { groupMembers, groupMembersError, loadGroupMembers, load } = useGroupLoader({
    refs,
    setGroup,
    setMemberGroups,
    setScreen,
    setMessage,
  });
  const { ledger, ledgerError, ledgerOwner, loadContributionLedger, refreshLedger } =
    useContributionLedger({ groupId: group?.group.id ?? null, mediaClient, refs });
  const { refreshGroup, reconcile, refreshFailed } = useGroupRefresh({
    group,
    screen,
    captureOpen: top?.kind === 'capture',
    now,
    refs,
    goHome,
    load,
    refreshLedger,
    ledgerOwner,
    setGroup,
  });

  const [blocked, setBlocked] = useBlockedMembers(
    top?.kind === 'settings' && top.step === 'members',
  );

  const closeCapture = () => {
    const before = ledger?.allowance.countUsed ?? 0;
    popScreen();
    void refreshGroup();
    void refreshLedger().then((page) => {
      // A moment was sealed: the allowance row rolls and the shutter says "Sealed".
      if (page && page.allowance.countUsed > before) setRollKey((key) => key + 1);
    });
  };

  const {
    pending,
    acceptPending,
    createError,
    setCreateError,
    joinFeedback,
    setJoinFeedback,
    joinedName,
    setJoinedName,
    invite,
    inviteFeedback,
    invitePending,
    create,
    createInvitation,
    revokeInvitation,
    copyInvitation,
    shareInvitation,
    acceptInvitation,
    switchGroup,
  } = useGroupMembershipFlows({
    group,
    refs,
    reminders,
    loadGroupMembers,
    goHome,
    setGroup,
    setMemberGroups,
    setScreen,
    setMessage,
    setTab,
  });

  const captureView = group ? (
    <GroupCaptureView
      group={group}
      allowance={ledger?.allowance ?? null}
      mediaClient={mediaClient}
      captureMode={captureMode}
      setCaptureMode={setCaptureMode}
      transferMode={transferMode}
      loadContributionLedger={loadContributionLedger}
      closeCapture={closeCapture}
    />
  ) : null;

  const signOutNotice = signOutNoticeFor(auth.notice);
  const signOutLabel = auth.pending
    ? 'Signing out…'
    : signOutNotice
      ? 'Retry sign out'
      : 'Sign out';

  const chatUnread = useRealChatUnread({
    groupId: screen === 'ready' ? (group?.group.id ?? null) : null,
    memberId: group?.memberId ?? null,
    chatActive: tab === 'chat' && !top,
  });
  const week = group ? cycleWeek(group.cycle, now) : null;
  const moments = weekMoments(ledger, week?.windowStart ?? 0);
  const failedMoment = moments.find((entry) => entry.state === 'failed') ?? null;
  const allowance = ledger?.allowance ?? null;
  const shutter = group && week ? shutterState(allowance, week.resetDays) : null;
  const premiere = group ? premiereRelease(group.releases, group.cycle.id) : undefined;
  const menuGroups: MenuGroup[] = memberGroups.map((membership) => ({
    id: membership.group.id,
    name: membership.group.name,
  }));
  if (group && !menuGroups.some((item) => item.id === group.group.id))
    menuGroups.unshift({ id: group.group.id, name: group.group.name });

  const watchPremiere = () => {
    if (premiere)
      pushScreen({
        kind: 'film',
        cycleId: premiere.cycleId,
        label: `Premiere · ${premiereLeft(premiere, now)}`,
      });
  };
  const pickGroup = async (groupId: string) => {
    setMenuOpen(false);
    const name = memberGroups.find((membership) => membership.group.id === groupId)?.group.name;
    if ((await switchGroup(groupId)) && name) toast(`Switched to ${name}.`);
  };
  const header = (
    <TopBar
      accountName={displayName}
      groupName={group ? group.group.name : null}
      menuOpen={menuOpen}
      onOpenSettings={() => {
        setMenuOpen(false);
        pushScreen({ kind: 'settings', step: 'main' });
      }}
      onToggleMenu={() => setMenuOpen((open) => !open)}
    />
  );
  const notices = (
    <GroupNotices
      inviteIntent={inviteIntent}
      acceptPending={acceptPending}
      joinFeedback={joinFeedback}
      onAcceptInvite={(code, groupId) => void acceptInvitation(code, groupId)}
      signOutNotice={signOutNotice}
      message={message}
      refreshFailed={Boolean(group && (refreshFailed || ledgerError))}
      onRetryRefresh={() => void reconcile(true)}
    />
  );

  let body: ReactNode;
  if (screen === 'loading') body = <LoadingState header={header} />;
  else if (screen === 'error')
    body = (
      <HomeState
        action="Try again"
        actionTestID="real-group-retry"
        body="Check your connection and try again."
        dim
        header={header}
        onAction={() => {
          setMessage(null);
          setScreen('loading');
          void load();
        }}
        testID="real-group-error"
        title="Couldn’t load your group"
      />
    );
  else if (!group)
    body = (
      <HomeState
        action="Have an invite?"
        actionTestID="real-group-join-start"
        alt="Create a group"
        altTestID="real-group-create-choice"
        body="Join one with an invite code, or start your own."
        header={header}
        onAction={() => pushScreen({ kind: 'join' })}
        onAlt={() => pushScreen({ kind: 'create' })}
        primary
        testID="real-group-none"
        title="You’re not in a group yet"
      >
        {notices}
      </HomeState>
    );
  else if (tab === 'chat')
    body = (
      <View style={styles.fill}>
        <View style={[styles.pinnedHeader, { paddingTop: insets.top }]}>{header}</View>
        <RealAccountChatScreen
          key={`${group.group.id}:${group.memberId ?? ''}`}
          groupId={group.group.id}
          groupName={group.group.name}
          members={groupMembers?.members ?? []}
          memberProfilesError={groupMembersError}
          currentMemberId={group.memberId}
          blocked={blocked}
          onBlocked={(memberId) => setBlocked((current) => new Set(current).add(memberId))}
          unreadOnOpen={chatUnreadAtOpen}
          premiere={premiere ? { left: premiereLeft(premiere, now), onWatch: watchPremiere } : null}
          bottomInset={chatKeyboard.keyboardOpen ? 8 : LAYOUT.dockHeight + insets.bottom + 12}
          keyboardOpen={chatKeyboard.keyboardOpen}
          onComposerFocus={chatKeyboard.onFocus}
          onComposerBlur={chatKeyboard.onBlur}
          onUnknownAuthor={() =>
            void loadGroupMembers(group.group.id, refs.groupContextVersionRef.current, true)
          }
        />
      </View>
    );
  else if (tab === 'archive')
    body = (
      <ArchiveScreen
        key={`${group.group.id}:${auth.session?.account.id ?? ''}`}
        bottomInset={LAYOUT.dockHeight + insets.bottom + 40}
        client={archiveClient}
        currentCycleId={group.cycle.id}
        countdown={filmCountdown(group.cycle.endsAt, now)}
        groupId={group.group.id}
        header={header}
        onOpenFilm={(cycleId, label) => pushScreen({ kind: 'film', cycleId, label })}
        prompt={group.cycle.prompt}
        releases={group.releases ?? []}
        topInset={insets.top}
      />
    );
  else
    body = (
      <ScrollView
        contentContainerStyle={[styles.tabContent, { paddingTop: insets.top }]}
        showsVerticalScrollIndicator={false}
        style={styles.fill}
        testID="real-group-experience"
      >
        <HomeBody
          cards={homeCards(group.releases, group.cycle.id, Boolean(failedMoment))}
          countUsed={allowance?.countUsed ?? null}
          countdown={filmCountdown(group.cycle.endsAt, now)}
          header={header}
          maxCount={allowance?.maxCount ?? group.cycle.quota.maxCount}
          maxSeconds={allowance?.maxSeconds ?? group.cycle.quota.maxSeconds}
          moments={
            ledger
              ? moments.map((entry) => ({
                  id: entry.contributionId,
                  mediaType: entry.mediaType,
                  seconds: Math.round(entry.durationSeconds),
                  day: momentDay(entry.createdAt, now),
                  failed: entry.state === 'failed',
                }))
              : null
          }
          notices={notices}
          onOpenMoments={() => pushScreen({ kind: 'mine' })}
          onRetryFailed={() => pushScreen({ kind: 'mine' })}
          onWatch={watchPremiere}
          premiereLeft={premiere ? premiereLeft(premiere, now) : null}
          prompt={group.cycle.prompt}
          resetDays={week?.resetDays ?? 7}
          rollKey={rollKey}
          secondsUsed={allowance?.secondsUsed ?? null}
          week={week?.week ?? 1}
        />
      </ScrollView>
    );

  if (screen !== 'ready' || !group)
    body = (
      <ScrollView
        contentContainerStyle={[styles.tabContent, styles.stateContent, { paddingTop: insets.top }]}
        style={styles.fill}
      >
        {body}
      </ScrollView>
    );

  const settingsTop = top?.kind === 'settings' ? top : null;
  let pushed: ReactNode = null;
  if (top?.kind === 'capture' && group) pushed = <View style={styles.camera}>{captureView}</View>;
  else if (settingsTop)
    pushed = (
      <SettingsScreen
        account={{
          displayName,
          username: auth.session?.account.username ?? displayName,
          id: auth.session?.account.id ?? '',
        }}
        authenticatedRequest={auth.authenticatedRequest}
        blocked={blocked}
        group={group}
        groups={menuGroups}
        invite={{
          code: invite ? displayInviteCode(invite.code) : null,
          pending: invitePending,
          feedback: inviteFeedback,
          create: () => void createInvitation(),
          revoke: () => void revokeInvitation(),
          copy: () => void copyInvitation(),
          share: () => void shareInvitation(),
        }}
        members={groupMembers?.members ?? null}
        membersError={groupMembersError}
        pendingInvites={groupMembers ? groupMembers.pendingInviteCount : null}
        notice={signOutNotice}
        onBack={popScreen}
        onBlockedChange={(profileId, isBlocked) =>
          setBlocked((current) => {
            const next = new Set(current);
            if (isBlocked) next.add(profileId);
            else next.delete(profileId);
            return next;
          })
        }
        onCreate={() => pushScreen({ kind: 'create' })}
        onDeleteAccount={auth.deleteAccount}
        signInMethod={auth.session?.signInMethod}
        onGroupUpdated={(updated) =>
          setGroup((current) =>
            current ? { ...updated, releases: updated.releases ?? current.releases } : updated,
          )
        }
        onJoin={() => pushScreen({ kind: 'join' })}
        onNavigate={(step) => replaceScreen({ kind: 'settings', step })}
        onSwitchGroup={switchGroup}
        reminderClient={reminderClient}
        signOut={{ label: signOutLabel, pending: auth.pending, onSignOut: signOut }}
        step={settingsTop.step}
        switchPending={pending}
      />
    );
  else if (top?.kind === 'film' && group && archiveClient)
    pushed = (
      <FilmScreen
        client={archiveClient}
        cycleId={top.cycleId}
        groupId={group.group.id}
        isOwner={group.group.role === 'owner'}
        label={top.label}
        onChat={() => {
          setStack([]);
          setTab('chat');
        }}
        onClose={popScreen}
        request={auth.authenticatedRequest}
      />
    );
  else if (top?.kind === 'mine')
    pushed = (
      <MomentsScreen
        error={ledgerError}
        onBack={popScreen}
        onReload={() => void refreshLedger()}
        onDelete={async (entry) => {
          if (!group) return;
          await mediaClient.deleteContribution(
            'real-account-session',
            group.group.id,
            entry.contributionId,
          );
          await refreshLedger();
        }}
        onRetake={() => {
          popScreen();
          void openCapture();
        }}
        onRetry={async (entry) => {
          if (!group || !entry.jobId || !mediaClient.processClipJob) return;
          await mediaClient.processClipJob('real-account-session', group.group.id, entry.jobId);
          await refreshLedger();
        }}
        page={ledger}
        resetDays={week?.resetDays ?? 7}
        windowStart={week?.windowStart ?? 0}
      />
    );
  else if (top?.kind === 'join')
    pushed = (
      <JoinScreen
        error={joinFeedback}
        joinedName={joinedName}
        onBack={() => {
          setJoinFeedback(null);
          setJoinedName(null);
          popScreen();
        }}
        onGoToGroup={() => {
          setJoinedName(null);
          goHome();
        }}
        onJoin={(code) => void acceptInvitation(code)}
        pending={acceptPending}
      />
    );
  else if (top?.kind === 'create')
    pushed = (
      <CreateGroupScreen
        error={createError}
        onBack={() => {
          setCreateError(null);
          popScreen();
        }}
        onCreate={(input) => void create(input)}
        pending={pending}
      />
    );

  const docked = screen === 'ready' && group;
  return (
    <View
      style={[
        styles.root,
        // Fixed positioning removes document scrollY; offsetTop follows Safari's
        // visual viewport pan, keeping both header and composer above the keyboard.
        chatKeyboard.keyboardOpen && {
          position: 'fixed' as 'absolute',
          top: chatKeyboard.offsetTop,
          left: 0,
          right: 0,
          height: chatKeyboard.height ?? undefined,
        },
      ]}
      testID="real-group-shell"
      {...rw('clip')}
    >
      {tab === 'home' || !group ? <Glow /> : null}
      <TabColumn>{body}</TabColumn>
      {docked && !chatKeyboard.keyboardOpen ? <ScreenFades /> : null}
      {docked && !chatKeyboard.keyboardOpen ? (
        <Dock
          active={tab}
          chatUnread={chatUnread}
          newFilm={Boolean(premiere)}
          onSelect={(next) => {
            setMenuOpen(false);
            if (next === 'chat' && tab !== 'chat') setChatUnreadAtOpen(chatUnread);
            setTab(next);
          }}
          onShutter={() => void openCapture()}
          shutter={shutter}
          shutterPending={capturePending}
          sealedTip={rollKey}
        />
      ) : null}
      {menuOpen && group ? (
        <GroupMenu
          currentId={group.group.id}
          disabled={pending}
          groups={menuGroups}
          onClose={() => setMenuOpen(false)}
          onCreate={() => {
            setMenuOpen(false);
            pushScreen({ kind: 'create' });
          }}
          onJoin={() => {
            setMenuOpen(false);
            pushScreen({ kind: 'join' });
          }}
          onPick={(groupId) => void pickGroup(groupId)}
        />
      ) : null}
      {pushed ? (
        <View key={stack.length} style={styles.pushed} {...rw('push')}>
          {pushed}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: WARM.bg, flex: 1, overflow: 'hidden' },
  fill: { flex: 1 },
  tabContent: { paddingBottom: 150, paddingHorizontal: LAYOUT.gutter },
  stateContent: { paddingBottom: 40 },
  pinnedHeader: { paddingHorizontal: LAYOUT.gutter },
  pushed: { ...StyleSheet.absoluteFill, zIndex: 10 },
  camera: { backgroundColor: '#000', flex: 1 },
});
