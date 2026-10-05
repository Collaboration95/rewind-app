import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type AccessibilityActionEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import type { ContributionLedgerAllowance } from '../domain/contributions';
import { CAPTURE_MODE_LABELS, CAPTURE_MODES, type CaptureMode } from '../domain/video';
import { Icon, type IconName } from '../ui/Icon';
import { ArcRing } from '../ui/Ring';
import { Button, Dialog, IconButton, rw, useScreenInsets } from '../ui/primitives';
import { DARK, FONT, WARM, serif } from '../ui/tokens';
import { ContributionStatusPanel, type ContributionStatus } from './contribution-status';

// The Warm Glass camera (design V1–V8, P1–P2): one dark full-screen
// viewfinder with the controls floating over it. Shared by the photo and
// video screens so both modes look and behave the same.

const isWeb = Platform.OS === 'web';
const INK = '#fff';
const MUTED = 'rgba(255, 255, 255, 0.82)';
const PEACH = '#ffd9b0';

/** A photo takes 3 s of the weekly film allowance. */
export const PHOTO_SECONDS = 3;

export function allowanceLeft(allowance: ContributionLedgerAllowance | undefined | null) {
  if (!allowance) return null;
  return {
    moments: Math.max(0, allowance.maxCount - allowance.countUsed),
    seconds: Math.max(0, Math.floor(allowance.maxSeconds - allowance.secondsUsed)),
  };
}

/** 6.2 → "0:06", as the design's recording timer reads. */
export function clock(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** Full-screen dark frame; the warm viewfinder glow sits behind any live preview. */
export function CameraFrame({
  children,
  testID,
  bokeh,
}: {
  children: ReactNode;
  testID: string;
  /** Out-of-focus warm lights, when there is no live camera image. */
  bokeh?: boolean;
}) {
  return (
    <View style={[styles.frame, { padding: 0 }]} testID={testID} {...rw('viewfinder')}>
      {bokeh && isWeb ? (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          pointerEvents="none"
          style={StyleSheet.absoluteFill}
        >
          {BOKEH.map(([left, top, size, color]) => (
            <View
              key={`${left}-${top}`}
              style={[
                styles.bokeh,
                { left, top, width: size, height: size, backgroundColor: color },
              ]}
              {...rw('bokeh')}
            />
          ))}
        </View>
      ) : null}
      {children}
    </View>
  );
}

const BOKEH: [`${number}%`, `${number}%`, number, string][] = [
  ['28%', '30%', 150, 'rgba(255, 168, 110, 0.55)'],
  ['72%', '22%', 110, 'rgba(255, 214, 140, 0.5)'],
  ['60%', '58%', 180, 'rgba(255, 138, 118, 0.4)'],
  ['22%', '70%', 120, 'rgba(255, 196, 120, 0.45)'],
];

/** Top bar: Close, the weekly allowance pill and the group it is for. */
export function CamTop({
  onClose,
  closeLabel = 'Close',
  closeTestID,
  allowance,
  groupName,
  children,
}: {
  onClose?: () => void;
  closeLabel?: string;
  closeTestID?: string;
  allowance?: ContributionLedgerAllowance | null;
  groupName?: string;
  children?: ReactNode;
}) {
  const insets = useScreenInsets();
  const left = allowanceLeft(allowance);
  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.top,
        {
          paddingTop: insets.top + 6,
          paddingLeft: insets.left + 18,
          paddingRight: insets.right + 18,
        },
      ]}
    >
      <View pointerEvents="box-none" style={styles.topRow}>
        {onClose ? (
          <IconButton
            dark
            icon="close"
            label={closeLabel}
            onPress={onClose}
            size={44}
            testID={closeTestID}
          />
        ) : (
          <View style={styles.side} />
        )}
        {left ? (
          <Text
            accessibilityLabel={`${left.moments} moments and ${left.seconds} seconds left this week`}
            style={styles.pill}
            testID="camera-allowance"
            {...rw('dark-glass')}
          >
            {left.moments} left · {left.seconds} s
          </Text>
        ) : null}
        <View style={styles.side} />
      </View>
      {groupName ? (
        <Text accessibilityLiveRegion="polite" style={styles.group} testID="camera-group-context">
          Group · {groupName}
        </Text>
      ) : null}
      {children}
    </View>
  );
}

/** Bottom area over the viewfinder, padded above the home indicator. */
export function CamBottom({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const insets = useScreenInsets();
  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.bottom,
        {
          paddingBottom: insets.bottom + 24,
          paddingLeft: insets.left + 22,
          paddingRight: insets.right + 22,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** Video / Photo switch (the design's `.cam-modes`). */
export function ModeSwitch({
  mode,
  onVideo,
  onPhoto,
  videoTestID,
  photoTestID,
}: {
  mode: 'video' | 'photo';
  onVideo?: () => void;
  onPhoto?: () => void;
  videoTestID?: string;
  photoTestID?: string;
}) {
  if (mode === 'photo' ? !onVideo : !onPhoto) return null;
  const tab = (key: 'video' | 'photo', label: string, onPress?: () => void, testID?: string) => {
    const selected = mode === key;
    return (
      <Pressable
        accessibilityRole="tab"
        accessibilityState={{ selected }}
        key={key}
        onPress={selected ? undefined : onPress}
        style={[styles.modeTab, selected && styles.modeTabOn]}
        testID={testID}
      >
        <Text style={[styles.modeText, selected && styles.modeTextOn]}>{label}</Text>
      </Pressable>
    );
  };
  return (
    <View
      accessibilityLabel="Capture mode"
      accessibilityRole="tablist"
      style={styles.modes}
      {...rw('dark-pill')}
    >
      {tab('video', 'Video', onVideo, videoTestID)}
      {tab('photo', 'Photo', onPhoto, photoTestID)}
    </View>
  );
}

/** The round shutter with its record ring (the design's `.cam-shut`). */
export function Shutter({
  kind,
  label,
  hint,
  onPress,
  disabled,
  busy,
  recording,
  fraction = 0,
  testID,
}: {
  kind: 'photo' | 'video';
  label: string;
  hint?: string;
  onPress?: () => void;
  disabled?: boolean;
  busy?: boolean;
  recording?: boolean;
  fraction?: number;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityHint={hint}
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ busy: Boolean(busy), disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.shutter, disabled && styles.off, pressed && styles.pressed]}
      testID={testID}
    >
      <ArcRing fraction={fraction} off={DARK.ringOff} on={WARM.ringOn} size={86} />
      <View
        style={[
          styles.core,
          kind === 'video' && styles.coreVideo,
          recording && styles.coreRecording,
        ]}
      />
    </Pressable>
  );
}

/** A side slot in the shutter row, so the shutter stays centred. */
export function ShutterRow({
  left,
  center,
  right,
}: {
  left?: ReactNode;
  center: ReactNode;
  right?: ReactNode;
}) {
  return (
    <View style={styles.shutterRow}>
      <View style={styles.rowSide}>{left}</View>
      {center}
      <View style={[styles.rowSide, styles.rowSideRight]}>{right}</View>
    </View>
  );
}

/** Lock count: how many moments are sealed; opens "Your moments". */
export function MomentsButton({ count, onPress }: { count?: number; onPress: () => void }) {
  return (
    <Pressable
      accessibilityLabel={count === undefined ? 'Your moments' : `Your moments: ${count} sealed`}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.mine, pressed && styles.pressed]}
      testID="camera-your-moments"
      {...rw('dark-glass')}
    >
      <Icon color={INK} name="lock" size={15} />
      {count === undefined ? null : <Text style={styles.mineText}>{count}</Text>}
    </Pressable>
  );
}

/** Pill buttons on the dark screen: peach for the main action, dark glass otherwise. */
export function CamButton({
  label,
  onPress,
  icon,
  primary,
  soft,
  disabled,
  busy,
  testID,
  accessibilityLabel,
  accessibilityHint,
  height = 56,
  style,
}: {
  label: string;
  onPress?: () => void;
  icon?: IconName;
  primary?: boolean;
  /** The light peach of the permission card's main button. */
  soft?: boolean;
  disabled?: boolean;
  busy?: boolean;
  testID?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  height?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const ink = primary || soft ? WARM.peachInk : INK;
  const inactive = Boolean(disabled || busy);
  return (
    <Pressable
      accessibilityHint={accessibilityHint}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ busy: Boolean(busy), disabled: inactive }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { height },
        primary ? styles.primaryNative : soft ? styles.softButton : !isWeb && styles.glassNative,
        inactive && styles.off,
        pressed && styles.pressed,
        style,
      ]}
      testID={testID}
      {...(primary ? rw('primary') : soft ? {} : rw('dark-glass'))}
    >
      {icon ? <Icon color={ink} name={icon} size={18} /> : null}
      <Text style={[styles.buttonText, { color: ink }]}>{label}</Text>
    </Pressable>
  );
}

/** A centred glass card over the dimmed viewfinder: permission and status states. */
export function CamCard({
  title,
  body,
  children,
  testID,
}: {
  title: string;
  body?: string | null;
  children?: ReactNode;
  testID?: string;
}) {
  return (
    <View pointerEvents="box-none" style={styles.cardLayer}>
      <View
        accessibilityLiveRegion="polite"
        style={[styles.card, !isWeb && styles.cardNative]}
        testID={testID}
        {...rw('dark-glass fade-in')}
      >
        <Text accessibilityRole="header" style={styles.cardTitle}>
          {title}
        </Text>
        {body ? <Text style={styles.cardBody}>{body}</Text> : null}
        <View style={styles.cardActions}>{children}</View>
      </View>
    </View>
  );
}

/** A short status or error line on a dark pill, readable over any camera image. */
export function Notice({
  children,
  alert = true,
  testID,
}: {
  children: ReactNode;
  alert?: boolean;
  testID?: string;
}) {
  return (
    <Text
      accessibilityLiveRegion={alert ? 'assertive' : 'polite'}
      accessibilityRole={alert ? 'alert' : undefined}
      style={styles.notice}
      testID={testID}
      {...rw('dark-pill')}
    >
      {children}
    </Text>
  );
}

/** Small label on the image, e.g. a clip that came from a file. */
export function Tag({ children }: { children: ReactNode }) {
  return (
    <Text style={styles.tag} {...rw('dark-pill')}>
      {children}
    </Text>
  );
}

/** V6: upload progress, which can be cancelled. */
export function UploadPanel({
  label,
  percent,
  onCancel,
  cancelLabel = 'Cancel upload',
  testID,
}: {
  label: string;
  percent?: number;
  onCancel?: () => void;
  cancelLabel?: string;
  testID?: string;
}) {
  return (
    <View style={styles.panel} testID={testID}>
      <View
        accessibilityLabel={label}
        accessibilityRole="progressbar"
        accessibilityValue={percent === undefined ? undefined : { min: 0, max: 100, now: percent }}
        style={styles.upbar}
      >
        {percent === undefined ? (
          <View style={[styles.upfill, { width: '35%' }]} {...rw('upbar slide')} />
        ) : (
          <View
            style={[styles.upfill, { width: `${Math.max(2, percent)}%` }]}
            {...rw('upbar fill')}
          />
        )}
      </View>
      <Text accessibilityLiveRegion="polite" style={styles.upText}>
        {label}
      </Text>
      {onCancel ? (
        <CamButton accessibilityLabel={cancelLabel} height={52} label="Cancel" onPress={onCancel} />
      ) : null}
    </View>
  );
}

/** V7: the upload did not finish; the moment stays on this phone. */
export function FailedPanel({
  title,
  detail,
  accessibilityLabel,
  onRetry,
  retryLabel = 'Retry upload',
  onBackToReview,
  onRetake,
  testID,
}: {
  title: string;
  detail?: string | null;
  accessibilityLabel: string;
  onRetry?: () => void;
  retryLabel?: string;
  onBackToReview?: () => void;
  onRetake?: () => void;
  testID?: string;
}) {
  return (
    <View style={styles.panel} testID={testID}>
      <View style={styles.upbar}>
        <View style={[styles.upfill, styles.upfillBad, { width: '64%' }]} />
      </View>
      <View accessibilityLabel={accessibilityLabel} accessibilityRole="alert" accessible>
        <Text style={styles.upText}>{title}</Text>
        {detail ? <Text style={styles.hint}>{detail}</Text> : null}
      </View>
      {onRetry ? (
        <CamButton
          accessibilityLabel={retryLabel}
          icon="replay"
          label="Retry"
          onPress={onRetry}
          primary
        />
      ) : null}
      {onBackToReview ? (
        <CamButton height={52} label="Back to review" onPress={onBackToReview} />
      ) : null}
      {onRetake ? <CamButton height={52} label="Retake" onPress={onRetake} /> : null}
    </View>
  );
}

/** V8: sealed. Done is the only way on. */
export function SealedOverlay({
  left,
  onDone,
  testID,
}: {
  left: number | null;
  onDone: () => void;
  testID?: string;
}) {
  return (
    <View
      accessibilityLiveRegion="polite"
      style={[StyleSheet.absoluteFill, styles.sealed, !isWeb && styles.sealedNative]}
      testID={testID}
      {...rw('sealed-veil now-in')}
    >
      <View style={styles.ok} {...rw('primary')}>
        <Icon color={WARM.peachInk} name="check" size={34} strokeWidth={2.4} />
      </View>
      <Text accessibilityRole="header" style={styles.sealedTitle}>
        Sealed
      </Text>
      <Text style={styles.sealedSub}>
        {left === null
          ? 'Finishing in the background'
          : `${left} left · finishing in the background`}
      </Text>
      <CamButton
        height={52}
        label="Done"
        onPress={onDone}
        primary
        style={styles.done}
        testID="camera-sealed-done"
      />
      <Text style={styles.sealedHint}>Nobody sees it before the film, not even you.</Text>
    </View>
  );
}

/** Four looks; Compact Digital is picked first (domain default). */
export function LookPicker({
  mode,
  onChange,
  disabled,
  testID,
}: {
  mode: CaptureMode;
  onChange: (mode: CaptureMode) => void;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <View
      accessibilityLabel="Look"
      accessibilityRole="radiogroup"
      style={styles.looks}
      testID={testID}
    >
      {CAPTURE_MODES.map((option) => {
        const selected = mode === option;
        return (
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ selected, disabled: Boolean(disabled) }}
            disabled={disabled}
            key={option}
            onPress={() => onChange(option)}
            style={[styles.look, selected ? styles.lookOn : !isWeb && styles.glassNative]}
            {...(selected ? {} : rw('dark-glass'))}
          >
            <Text style={[styles.lookText, selected && styles.lookTextOn]}>
              {CAPTURE_MODE_LABELS[option]}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Retake and Seal, side by side (the design's `.cam-acts`). */
export function ReviewActions({ children }: { children: ReactNode }) {
  return <View style={styles.acts}>{children}</View>;
}

/** White flash when a photo is taken; a cut when Reduce Motion is on. */
export function FlashFx({ fire }: { fire: number }) {
  if (!fire || !isWeb) return null;
  return (
    <View
      key={fire}
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, styles.flash]}
      {...rw('flash')}
    />
  );
}

/** "Your moments": the latest moment's status, with delete and replace. */
export function MomentsDialog({
  status,
  onClose,
  onDelete,
  onRetry,
  retryLabel,
}: {
  status: ContributionStatus | null;
  onClose: () => void;
  onDelete?: () => void | Promise<void>;
  onRetry?: () => void | Promise<void>;
  retryLabel?: string;
}) {
  return (
    <Dialog
      label="Your moments"
      onDismiss={onClose}
      title="Your moments"
      testID="camera-moments-dialog"
    >
      <ContributionStatusPanel
        deleteLabel="Delete and replace"
        onDelete={onDelete}
        onRetry={onRetry}
        retryLabel={retryLabel}
        status={status}
        testID="camera-contribution-status"
      />
      <Button height={48} label="Close" onPress={onClose} />
    </Dialog>
  );
}

const TRIM_MIN = 0.5;
const TRIM_STEP = 0.5;
const tenth = (value: number) => Math.round(value * 10) / 10;

function moveHandle(
  current: {
    start: number;
    end: number;
    duration: number;
    onChange: (start: number, end: number) => void;
  },
  which: 'start' | 'end',
  value: number,
) {
  const { start, end, duration, onChange } = current;
  if (which === 'start') onChange(Math.min(Math.max(0, tenth(value)), tenth(end - TRIM_MIN)), end);
  else onChange(start, Math.max(Math.min(duration, tenth(value)), tenth(start + TRIM_MIN)));
}

/**
 * Trim strip with a handle at either side (V5). The window never drops below
 * half a second and never leaves the clip. Handles drag, and screen readers
 * adjust them in half-second steps.
 */
export function TrimBar({
  duration,
  start,
  end,
  onChange,
  disabled,
}: {
  duration: number;
  start: number;
  end: number;
  onChange: (start: number, end: number) => void;
  disabled?: boolean;
}) {
  const [width, setWidth] = useState(0);
  const latest = useRef({ start, end, duration, width, onChange });
  useEffect(() => {
    latest.current = { start, end, duration, width, onChange };
  });

  const move = (which: 'start' | 'end', value: number) =>
    moveHandle({ start, end, duration, onChange }, which, value);
  const responders = useMemo(() => {
    const make = (which: 'start' | 'end') => {
      let origin = 0;
      return PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          origin = latest.current[which];
        },
        onPanResponderMove: (_event, gesture) => {
          const { width: w, duration: d } = latest.current;
          if (w > 0) moveHandle(latest.current, which, origin + (gesture.dx / w) * d);
        },
      });
    };
    // The responders read the refs only inside gesture callbacks, not during render.
    // eslint-disable-next-line react-hooks/refs
    return { start: make('start'), end: make('end') };
  }, []);

  const pct = (value: number) => `${(value / duration) * 100}%` as const;
  const handle = (which: 'start' | 'end') => {
    const value = which === 'start' ? start : end;
    return (
      <View
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        accessibilityLabel={which === 'start' ? 'Trim start' : 'Trim end'}
        accessibilityRole="adjustable"
        accessibilityState={{ disabled: Boolean(disabled) }}
        accessibilityValue={{ text: `${value.toFixed(1)} seconds` }}
        aria-valuemax={duration}
        aria-valuemin={0}
        aria-valuenow={value}
        aria-valuetext={`${value.toFixed(1)} seconds`}
        accessible
        onAccessibilityAction={(event: AccessibilityActionEvent) => {
          if (disabled) return;
          const step = event.nativeEvent.actionName === 'increment' ? TRIM_STEP : -TRIM_STEP;
          move(which, value + step);
        }}
        // Web has no accessibility actions: arrow keys move a focused handle instead.
        focusable={!disabled}
        // @ts-expect-error react-native-web forwards keyboard events on View.
        onKeyDown={(event: { key: string; preventDefault: () => void }) => {
          const step = {
            ArrowRight: TRIM_STEP,
            ArrowUp: TRIM_STEP,
            ArrowLeft: -TRIM_STEP,
            ArrowDown: -TRIM_STEP,
          }[event.key];
          if (disabled || step === undefined) return;
          event.preventDefault();
          move(which, value + step);
        }}
        style={[styles.handle, { left: pct(value) }]}
        testID={which === 'start' ? 'video-trim-start' : 'video-trim-end'}
        {...(disabled ? {} : responders[which].panHandlers)}
      >
        <View style={styles.handleBar} />
      </View>
    );
  };

  return (
    <View style={styles.trimWrap}>
      <View
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        style={styles.trim}
        testID="video-trim"
      >
        <View style={styles.strip}>
          {TILES.map((color, index) => (
            <View key={index} style={[styles.tile, { backgroundColor: color }]} />
          ))}
        </View>
        <View pointerEvents="none" style={[styles.shade, { left: 0, width: pct(start) }]} />
        <View pointerEvents="none" style={[styles.shade, { left: pct(end), right: 0 }]} />
        <View
          pointerEvents="none"
          style={[styles.window, { left: pct(start), width: pct(end - start) }]}
        />
        {handle('start')}
        {handle('end')}
      </View>
      <Text style={styles.trimText} testID="video-trim-text">
        {start.toFixed(1)} – {end.toFixed(1)} s · {(end - start).toFixed(1)} s
      </Text>
    </View>
  );
}

const TILES = [
  '#6b3b2a',
  '#c9704a',
  '#e9925f',
  '#a85a3a',
  '#ffcf8a',
  '#8a4a32',
  '#e9925f',
  '#c9704a',
  '#ffd2a0',
];

const styles = StyleSheet.create({
  frame: {
    backgroundColor: '#120b08',
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
    position: 'relative',
  },
  bokeh: { borderRadius: 999, position: 'absolute' },
  top: { left: 0, position: 'absolute', right: 0, top: 0, zIndex: 6, gap: 8 },
  topRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  side: { height: 44, width: 44 },
  pill: {
    borderRadius: 999,
    color: INK,
    fontFamily: FONT.body,
    fontSize: 13.5,
    fontWeight: '500',
    overflow: 'hidden',
    paddingHorizontal: 15,
    paddingVertical: 10,
    backgroundColor: isWeb ? undefined : 'rgba(255, 255, 255, 0.16)',
  },
  group: {
    alignSelf: 'center',
    color: MUTED,
    fontFamily: FONT.body,
    fontSize: 12.5,
    textShadowColor: 'rgba(0, 0, 0, 0.6)',
    textShadowRadius: 6,
  },
  bottom: {
    alignItems: 'center',
    bottom: 0,
    gap: 16,
    left: 0,
    position: 'absolute',
    right: 0,
    zIndex: 4,
  },
  modes: {
    backgroundColor: isWeb ? undefined : 'rgba(0, 0, 0, 0.4)',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 4,
    padding: 4,
  },
  modeTab: { borderRadius: 999, justifyContent: 'center', minHeight: 44, paddingHorizontal: 16 },
  modeTabOn: { backgroundColor: PEACH },
  modeText: {
    color: MUTED,
    fontFamily: FONT.body,
    fontSize: 12.5,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  modeTextOn: { color: WARM.peachInk },
  shutterRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '100%',
    paddingHorizontal: 18,
  },
  rowSide: { alignItems: 'flex-start', width: 56 },
  rowSideRight: { alignItems: 'flex-end' },
  shutter: {
    alignItems: 'center',
    borderRadius: 43,
    height: 86,
    justifyContent: 'center',
    width: 86,
  },
  core: {
    backgroundColor: '#fff',
    borderRadius: 33,
    boxShadow: '0 6px 18px rgba(0, 0, 0, 0.35)',
    height: 66,
    width: 66,
  },
  coreVideo: { backgroundColor: '#f0603f' },
  coreRecording: { borderRadius: 9, height: 32, width: 32 },
  off: { opacity: 0.45 },
  pressed: { opacity: 0.85, transform: [{ scale: 0.96 }] },
  mine: {
    alignItems: 'center',
    backgroundColor: isWeb ? undefined : 'rgba(255, 255, 255, 0.16)',
    borderRadius: 14,
    flexDirection: 'row',
    gap: 4,
    height: 48,
    justifyContent: 'center',
    width: 48,
  },
  mineText: { color: INK, fontFamily: FONT.body, fontSize: 15 },
  button: {
    alignItems: 'center',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  primaryNative: { backgroundColor: '#ffb784' },
  softButton: { backgroundColor: PEACH },
  glassNative: { backgroundColor: 'rgba(255, 255, 255, 0.16)' },
  buttonText: { fontFamily: FONT.body, fontSize: 16, fontWeight: '600' },
  cardLayer: {
    ...StyleSheet.absoluteFill,
    justifyContent: 'center',
    paddingHorizontal: 26,
    zIndex: 5,
  },
  card: {
    alignSelf: 'center',
    borderRadius: 30,
    maxWidth: 440,
    paddingHorizontal: 22,
    paddingVertical: 26,
    width: '100%',
  },
  cardNative: { backgroundColor: 'rgba(48, 32, 24, 0.92)' },
  cardTitle: { color: INK, marginBottom: 8, textAlign: 'center', ...serif(26) },
  cardBody: {
    color: MUTED,
    fontFamily: FONT.body,
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 20,
    textAlign: 'center',
  },
  cardActions: { alignItems: 'stretch', gap: 12 },
  notice: {
    alignSelf: 'center',
    backgroundColor: isWeb ? undefined : 'rgba(0, 0, 0, 0.55)',
    borderRadius: 14,
    color: INK,
    fontFamily: FONT.body,
    fontSize: 13.5,
    lineHeight: 19,
    maxWidth: 440,
    overflow: 'hidden',
    paddingHorizontal: 14,
    paddingVertical: 8,
    textAlign: 'center',
  },
  tag: {
    alignSelf: 'center',
    backgroundColor: isWeb ? undefined : 'rgba(0, 0, 0, 0.5)',
    borderRadius: 999,
    color: INK,
    fontFamily: FONT.body,
    fontSize: 12,
    fontWeight: '600',
    overflow: 'hidden',
    paddingHorizontal: 11,
    paddingVertical: 6,
  },
  panel: { alignSelf: 'stretch', gap: 12 },
  upbar: {
    backgroundColor: 'rgba(255, 255, 255, 0.18)',
    borderRadius: 3,
    height: 6,
    overflow: 'hidden',
  },
  upfill: {
    backgroundColor: '#ffb784',
    borderRadius: 3,
    bottom: 0,
    left: 0,
    position: 'absolute',
    top: 0,
  },
  upfillBad: { backgroundColor: '#e0705a' },
  upText: { color: INK, fontFamily: FONT.monoMedium, fontSize: 14, textAlign: 'center' },
  hint: {
    color: MUTED,
    fontFamily: FONT.body,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 6,
    textAlign: 'center',
  },
  sealed: { alignItems: 'center', gap: 10, justifyContent: 'center', padding: 24, zIndex: 8 },
  sealedNative: { backgroundColor: 'rgba(20, 12, 8, 0.9)' },
  ok: {
    alignItems: 'center',
    backgroundColor: isWeb ? undefined : '#ffb784',
    borderRadius: 38,
    height: 76,
    justifyContent: 'center',
    width: 76,
  },
  sealedTitle: { color: INK, marginTop: 6, ...serif(34) },
  sealedSub: { color: MUTED, fontFamily: FONT.body, fontSize: 14, textAlign: 'center' },
  done: { marginTop: 20, width: 260 },
  sealedHint: {
    color: MUTED,
    fontFamily: FONT.body,
    fontSize: 12.5,
    marginTop: 4,
    maxWidth: 250,
    textAlign: 'center',
  },
  looks: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center' },
  look: { borderRadius: 999, justifyContent: 'center', minHeight: 44, paddingHorizontal: 13 },
  lookOn: { backgroundColor: PEACH },
  lookText: { color: INK, fontFamily: FONT.body, fontSize: 12.5 },
  lookTextOn: { color: WARM.peachInk, fontWeight: '600' },
  acts: { alignSelf: 'stretch', flexDirection: 'row', gap: 12 },
  flash: { backgroundColor: '#fff', opacity: 0, zIndex: 7 },
  trimWrap: { alignSelf: 'stretch', gap: 10, paddingHorizontal: 12 },
  trim: { height: 56, position: 'relative' },
  strip: { borderRadius: 12, flexDirection: 'row', height: '100%', overflow: 'hidden' },
  tile: { flex: 1 },
  shade: { backgroundColor: 'rgba(10, 6, 4, 0.6)', bottom: 0, position: 'absolute', top: 0 },
  window: {
    borderColor: PEACH,
    borderRadius: 14,
    borderWidth: 3,
    bottom: -3,
    position: 'absolute',
    top: -3,
  },
  handle: {
    alignItems: 'center',
    bottom: -4,
    justifyContent: 'center',
    marginLeft: -22,
    position: 'absolute',
    top: -4,
    width: 44,
  },
  handleBar: { backgroundColor: PEACH, borderRadius: 6, height: 38, width: 16 },
  trimText: { color: MUTED, fontFamily: FONT.monoMedium, fontSize: 12.5, textAlign: 'center' },
});
