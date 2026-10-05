import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon, type IconName } from '../ui/Icon';
import { Avatar, Glass, rw, useInsets } from '../ui/primitives';
import { SegmentRing } from '../ui/Ring';
import { FONT, LAYOUT, MOTION, WARM, serif } from '../ui/tokens';
import type { ShutterState } from './home-model';

const isWeb = Platform.OS === 'web';

export type ShellTab = 'home' | 'chat' | 'archive';

/* ---------- Header: group name in the middle, avatar on the right ---------- */

export function TopBar({
  groupName,
  menuOpen,
  onToggleMenu,
  accountName,
  onOpenSettings,
}: {
  /** Null when there is no group yet: the header says Rewind and is not a menu. */
  groupName: string | null;
  menuOpen?: boolean;
  onToggleMenu?: () => void;
  accountName: string;
  onOpenSettings: () => void;
}) {
  return (
    <View style={styles.top}>
      <View style={styles.topSide} />
      {groupName === null ? (
        <Text accessibilityRole="header" style={styles.brand}>
          Rewind
        </Text>
      ) : (
        <Pressable
          accessibilityLabel={`${groupName} · switch group`}
          accessibilityRole="button"
          accessibilityState={{ expanded: Boolean(menuOpen) }}
          aria-haspopup="menu"
          onPress={onToggleMenu}
          style={styles.groupButton}
          testID="real-group-menu-button"
        >
          <Text
            accessibilityRole="header"
            numberOfLines={1}
            style={styles.groupName}
            testID="real-group-name-heading"
          >
            {groupName}
          </Text>
          <View style={menuOpen ? styles.chevOpen : undefined}>
            <Icon color={WARM.muted} name="chev" size={16} />
          </View>
        </Pressable>
      )}
      <Pressable
        accessibilityLabel={`${accountName} · settings`}
        accessibilityRole="button"
        hitSlop={4}
        onPress={onOpenSettings}
        style={styles.me}
        testID="real-account-settings-button"
      >
        <Avatar glass name={accountName} />
      </Pressable>
    </View>
  );
}

/* ---------- Group menu ---------- */

export interface MenuGroup {
  id: string;
  name: string;
  unread?: number;
}

export function GroupMenu({
  groups,
  currentId,
  removedId,
  onPick,
  onJoin,
  onCreate,
  onClose,
  disabled,
}: {
  groups: MenuGroup[];
  currentId: string | null;
  /** The group this account was removed from (H11): shown greyed. */
  removedId?: string | null;
  onPick: (groupId: string) => void;
  onJoin: () => void;
  onCreate: () => void;
  onClose: () => void;
  disabled?: boolean;
}) {
  const insets = useInsets();
  useEffect(() => {
    if (!isWeb || typeof window === 'undefined') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <View style={StyleSheet.absoluteFill}>
      <Pressable
        accessibilityLabel="Close the group menu"
        onPress={onClose}
        style={StyleSheet.absoluteFill}
        testID="real-group-menu-dismiss"
      />
      <Glass
        accessibilityLabel="Switch group"
        extra="menu-in"
        role="menu"
        style={[styles.menu, { top: Math.max(insets.top, 10) + 52 }]}
        testID="real-group-switcher"
        variant="menu"
      >
        <Text style={styles.menuLabel}>Your groups</Text>
        {groups.map((group) => {
          if (group.id === removedId)
            return (
              <View
                accessibilityState={{ disabled: true }}
                key={group.id}
                role="menuitem"
                style={[styles.menuRow, styles.menuRowOff]}
              >
                <Icon color={WARM.muted} name="users" size={20} />
                <View style={styles.menuText}>
                  <Text style={[styles.menuName, { color: WARM.muted }]}>{group.name}</Text>
                  <Text style={styles.menuRemoved}>You’re no longer in this group</Text>
                </View>
              </View>
            );
          const current = group.id === currentId;
          return (
            <Pressable
              accessibilityLabel={`${group.name}${group.unread ? `, ${group.unread} unread` : ''}`}
              accessibilityState={{ checked: current, disabled: Boolean(disabled) }}
              disabled={disabled}
              key={group.id}
              onPress={() => (current ? onClose() : onPick(group.id))}
              role="menuitem"
              style={({ pressed }) => [
                styles.menuRow,
                current && styles.menuRowOn,
                pressed && styles.pressed,
              ]}
              testID={`switch-real-group-${group.id}`}
            >
              <Icon color={WARM.muted} name="users" size={20} />
              <Text numberOfLines={1} style={[styles.menuName, current && styles.menuNameOn]}>
                {group.name}
              </Text>
              {group.unread ? (
                <Text accessibilityElementsHidden style={styles.menuCount}>
                  {group.unread}
                </Text>
              ) : null}
              {current ? <Icon color="#b4521f" name="check" size={20} strokeWidth={2.4} /> : null}
            </Pressable>
          );
        })}
        <View style={styles.menuRule} />
        <Pressable
          onPress={onJoin}
          role="menuitem"
          style={({ pressed }) => [styles.menuRow, pressed && styles.pressed]}
          testID="real-group-menu-join"
        >
          <Icon color={WARM.muted} name="key" size={20} />
          <Text style={styles.menuName}>Have an invite?</Text>
        </Pressable>
        <Pressable
          onPress={onCreate}
          role="menuitem"
          style={({ pressed }) => [styles.menuRow, pressed && styles.pressed]}
          testID="real-group-menu-create"
        >
          <Icon color={WARM.muted} name="plus" size={20} />
          <Text style={styles.menuName}>Create a group</Text>
        </Pressable>
      </Glass>
    </View>
  );
}

/* ---------- Dock: three glass tabs and the shutter ---------- */

const TABS: { key: ShellTab; label: string; icon: IconName }[] = [
  { key: 'home', label: 'Home', icon: 'home' },
  { key: 'chat', label: 'Chat', icon: 'chat' },
  { key: 'archive', label: 'Archive', icon: 'archive' },
];

export function Dock({
  active,
  onSelect,
  chatUnread,
  newFilm,
  shutter,
  onShutter,
  shutterPending,
  sealedTip,
}: {
  active: ShellTab;
  onSelect: (tab: ShellTab) => void;
  chatUnread: number;
  newFilm: boolean;
  /** Null hides the shutter (error, denied or no group). */
  shutter: ShutterState | null;
  onShutter: () => void;
  shutterPending?: boolean;
  /** Changes whenever a moment was just sealed, to flash "Sealed". */
  sealedTip?: number;
}) {
  const insets = useInsets();
  return (
    <View
      accessibilityLabel="Main navigation"
      role="navigation"
      style={[styles.dock, { bottom: Math.max(insets.bottom - 6, 16) }]}
      testID="real-group-navigation"
    >
      <Glass style={styles.tabs} testID="real-group-tabs">
        {TABS.map((tab) => {
          const on = tab.key === active;
          const badge =
            tab.key === 'chat' && chatUnread > 0 && !on
              ? `, ${chatUnread} unread`
              : tab.key === 'archive' && newFilm && !on
                ? ', new film'
                : '';
          return (
            <Pressable
              accessibilityLabel={`${tab.label}${badge}`}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              aria-current={on ? 'page' : undefined}
              key={tab.key}
              onPress={() => onSelect(tab.key)}
              style={[styles.tab, on && !isWeb && styles.tabOnNative]}
              testID={`real-group-nav-${tab.key}`}
              {...(on ? rw('lens') : {})}
            >
              <View>
                <Icon color={on ? WARM.ink : WARM.muted} name={tab.icon} />
                {tab.key === 'chat' && chatUnread > 0 && !on ? (
                  <Text accessibilityElementsHidden style={styles.badge}>
                    {chatUnread > 99 ? '99+' : chatUnread}
                  </Text>
                ) : null}
                {tab.key === 'archive' && newFilm && !on ? <View style={styles.dot} /> : null}
              </View>
              <Text style={[styles.tabLabel, on && styles.tabLabelOn]}>{tab.label}</Text>
            </Pressable>
          );
        })}
      </Glass>
      {shutter ? (
        <Shutter
          pending={shutterPending}
          sealedTip={sealedTip}
          state={shutter}
          onPress={onShutter}
        />
      ) : null}
    </View>
  );
}

function Shutter({
  state,
  onPress,
  pending,
  sealedTip,
}: {
  state: ShutterState;
  onPress: () => void;
  pending?: boolean;
  sealedTip?: number;
}) {
  const [tip, setTip] = useState<{ text: string; id: number } | null>(null);
  const [nope, setNope] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = (text: string) => {
    if (timer.current) clearTimeout(timer.current);
    setTip((current) => ({ text, id: (current?.id ?? 0) + 1 }));
    timer.current = setTimeout(() => setTip(null), MOTION.tip);
  };
  useEffect(() => {
    if (sealedTip) void Promise.resolve().then(() => flash('Sealed'));
  }, [sealedTip]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const used = state.kind === 'used';
  const usedCount = state.kind === 'ready' ? 5 - state.left : 5;
  return (
    <View>
      {tip ? (
        <View
          accessibilityLiveRegion="polite"
          key={tip.id}
          pointerEvents="none"
          style={styles.tip}
          {...rw('tip')}
        >
          <Text style={styles.tipText}>{tip.text}</Text>
          <View style={styles.tipArrow} />
        </View>
      ) : null}
      <Pressable
        accessibilityLabel={state.label}
        accessibilityRole="button"
        accessibilityState={{ disabled: used || Boolean(pending), busy: Boolean(pending) }}
        aria-disabled={used || undefined}
        key={nope}
        onPress={() => {
          if (pending) return;
          if (state.kind === 'used') {
            setNope((value) => value + 1);
            flash(state.tip);
            return;
          }
          onPress();
        }}
        style={[styles.shutter, !isWeb && styles.shutterNative]}
        testID="real-group-capture-action"
        {...rw(nope ? 'glass nope' : 'glass')}
      >
        <SegmentRing used={usedCount} />
        <View
          style={[styles.core, !isWeb && styles.coreNative, used && !isWeb && styles.coreOffNative]}
          {...({ dataSet: { rw: 'core', off: String(used) } } as object)}
        >
          <Icon color="#4a2112" name="camera" size={26} />
        </View>
      </Pressable>
    </View>
  );
}

/* ---------- Tab frame: the faded status-bar edge and room for the dock ---------- */

export function ScreenFades({ dock = true }: { dock?: boolean }) {
  const insets = useInsets();
  return (
    <>
      <View
        pointerEvents="none"
        style={[
          styles.fadeTop,
          { height: Math.max(insets.top, 10) + 8 },
          !isWeb && styles.fadeNative,
        ]}
        {...rw('fade-top')}
      />
      {dock ? (
        <View
          pointerEvents="none"
          style={[styles.fadeBottom, !isWeb && styles.fadeBottomNative]}
          {...rw('fade-bottom')}
        />
      ) : null}
    </>
  );
}

export function TabColumn({ children }: { children: ReactNode }) {
  return <View style={styles.column}>{children}</View>;
}

const styles = StyleSheet.create({
  top: {
    alignItems: 'center',
    flexDirection: 'row',
    height: LAYOUT.headerHeight,
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  topSide: { width: 40 },
  brand: { color: WARM.ink, ...serif(19) },
  groupButton: {
    alignItems: 'center',
    flexDirection: 'row',
    flexShrink: 1,
    gap: 4,
    height: 44,
    justifyContent: 'center',
    maxWidth: '72%',
    paddingHorizontal: 6,
  },
  groupName: {
    color: WARM.ink,
    flexShrink: 1,
    fontFamily: FONT.body,
    fontSize: 15,
    fontWeight: '500',
  },
  chevOpen: { transform: [{ rotate: '180deg' }] },
  me: { alignItems: 'center', borderRadius: 24, height: 44, justifyContent: 'center', width: 44 },
  menu: {
    alignSelf: 'center',
    borderRadius: 24,
    left: '50%',
    marginLeft: -132,
    padding: 6,
    position: 'absolute',
    width: 264,
  },
  menuLabel: {
    color: WARM.muted,
    fontFamily: FONT.body,
    fontSize: 11,
    letterSpacing: 1.3,
    marginBottom: 6,
    marginHorizontal: 12,
    marginTop: 10,
    textTransform: 'uppercase',
  },
  menuRow: {
    alignItems: 'center',
    borderRadius: 18,
    flexDirection: 'row',
    gap: 12,
    minHeight: 46,
    paddingHorizontal: 12,
  },
  menuRowOn: {
    backgroundColor: 'rgba(255, 255, 255, 0.75)',
    boxShadow: 'inset 0 1px 1px #fff',
  },
  menuRowOff: { minHeight: 52 },
  menuText: { flex: 1 },
  menuName: { color: WARM.ink, flex: 1, fontFamily: FONT.body, fontSize: 15 },
  menuNameOn: { fontWeight: '600' },
  menuRemoved: { color: WARM.dangerInk, fontFamily: FONT.body, fontSize: 12, marginTop: 1 },
  menuCount: {
    backgroundColor: WARM.badge,
    borderRadius: 999,
    color: '#fff',
    fontFamily: FONT.body,
    fontSize: 11.5,
    fontWeight: '600',
    lineHeight: 20,
    minWidth: 20,
    overflow: 'hidden',
    paddingHorizontal: 6,
    textAlign: 'center',
  },
  menuRule: {
    borderTopColor: WARM.line,
    borderTopWidth: 1,
    marginHorizontal: 10,
    marginVertical: 6,
  },
  pressed: { opacity: 0.8 },
  dock: {
    alignItems: 'center',
    alignSelf: 'center',
    flexDirection: 'row',
    gap: 12,
    left: 16,
    maxWidth: LAYOUT.maxWidth - 32,
    position: 'absolute',
    right: 16,
    zIndex: 7,
  },
  tabs: {
    alignItems: 'center',
    borderRadius: 32,
    flex: 1,
    flexDirection: 'row',
    height: 64,
    padding: 6,
  },
  tab: {
    alignItems: 'center',
    borderRadius: 26,
    flex: 1,
    gap: 3,
    height: 52,
    justifyContent: 'center',
  },
  tabOnNative: { backgroundColor: 'rgba(255, 255, 255, 0.7)' },
  tabLabel: { color: WARM.muted, fontFamily: FONT.body, fontSize: 10.5, fontWeight: '500' },
  tabLabelOn: { color: WARM.ink },
  badge: {
    backgroundColor: WARM.badge,
    borderColor: WARM.bg,
    borderRadius: 9,
    borderWidth: 2,
    color: '#fff',
    fontFamily: FONT.body,
    fontSize: 10,
    fontWeight: '600',
    left: 11,
    lineHeight: 15,
    minWidth: 19,
    overflow: 'hidden',
    paddingHorizontal: 4,
    position: 'absolute',
    textAlign: 'center',
    top: -8,
  },
  dot: {
    backgroundColor: WARM.badge,
    borderColor: WARM.bg,
    borderRadius: 6,
    borderWidth: 2,
    height: 13,
    left: 15,
    position: 'absolute',
    top: -4,
    width: 13,
  },
  shutter: {
    alignItems: 'center',
    borderRadius: 38,
    height: LAYOUT.dockHeight,
    justifyContent: 'center',
    width: LAYOUT.dockHeight,
  },
  shutterNative: { backgroundColor: 'rgba(255, 255, 255, 0.6)' },
  core: { alignItems: 'center', borderRadius: 30, height: 60, justifyContent: 'center', width: 60 },
  coreNative: { backgroundColor: '#ffa766' },
  coreOffNative: { backgroundColor: '#d9cfc6' },
  tip: {
    backgroundColor: WARM.sheet,
    borderRadius: 12,
    bottom: LAYOUT.dockHeight + 10,
    boxShadow: '0 12px 24px -10px rgba(0, 0, 0, 0.5)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    position: 'absolute',
    right: 0,
  },
  tipText: { color: WARM.ink, fontFamily: FONT.body, fontSize: 12, fontWeight: '500' },
  tipArrow: {
    borderColor: 'transparent',
    borderTopColor: WARM.sheet,
    borderWidth: 6,
    position: 'absolute',
    right: 32,
    top: '100%',
  },
  fadeTop: { left: 0, position: 'absolute', right: 0, top: 0, zIndex: 4 },
  fadeNative: { backgroundColor: 'rgba(246, 237, 227, 0.92)' },
  fadeBottom: { bottom: 0, height: 140, left: 0, position: 'absolute', right: 0, zIndex: 6 },
  fadeBottomNative: { backgroundColor: 'transparent' },
  column: { alignSelf: 'center', flex: 1, maxWidth: LAYOUT.maxWidth, width: '100%' },
});
