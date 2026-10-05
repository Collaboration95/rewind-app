import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type PressableProps,
  type ScrollViewProps,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewProps,
  type ViewStyle,
} from 'react-native';
import { createPortal } from 'react-dom';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';

import { Icon, type IconName } from './Icon';
import { DARK, FONT, LAYOUT, MOTION, WARM, serif } from './tokens';

const isWeb = Platform.OS === 'web';

/** `data-rw` hooks for the web stylesheet (see web-styles.ts). */
export const rw = (value: string) => ({ dataSet: { rw: value } }) as object;

/** Mix a hex colour toward white, like the design's color-mix(in srgb, c p%, #fff). */
export function tint(hex: string, percent: number, base = '#ffffff'): string {
  const parse = (value: string) =>
    [1, 3, 5].map((index) => parseInt(value.slice(index, index + 2), 16));
  const [r, g, b] = parse(hex);
  const [R, G, B] = parse(base);
  const p = percent / 100;
  const channel = (a: number, z: number) =>
    Math.round(a * p + z * (1 - p))
      .toString(16)
      .padStart(2, '0');
  return `#${channel(r, R)}${channel(g, G)}${channel(b, B)}`;
}

/* ---------- Background glow ---------- */

export function Glow({ top = 60, style }: { top?: number; style?: StyleProp<ViewStyle> }) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={[styles.glow, { top }, !isWeb && styles.glowNative, style]}
      {...rw('glow')}
    >
      <View />
      <View />
      <View />
    </View>
  );
}

export function GlowLow() {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={styles.glowLow}
      {...rw('glow-low')}
    />
  );
}

/* ---------- Glass surfaces ---------- */

type GlassVariant = 'card' | 'menu' | 'dialog' | 'sheet' | 'composer';

export const Glass = forwardRef<
  View,
  ViewProps & { variant?: GlassVariant; /** Extra web effects, e.g. 'dlg-in'. */ extra?: string }
>(function Glass({ variant = 'card', extra, style, children, ...props }, ref) {
  return (
    <View
      ref={ref}
      {...props}
      style={[styles.glass, !isWeb && nativeGlass[variant], style]}
      {...rw(['glass', variant === 'card' ? '' : variant, extra ?? ''].filter(Boolean).join(' '))}
    >
      {children}
    </View>
  );
});

const nativeGlass: Record<GlassVariant, ViewStyle> = {
  card: { backgroundColor: 'rgba(255, 255, 255, 0.62)' },
  menu: { backgroundColor: 'rgba(255, 249, 242, 0.97)' },
  dialog: { backgroundColor: 'rgba(255, 250, 244, 0.97)' },
  sheet: { backgroundColor: 'rgba(255, 250, 244, 0.95)' },
  composer: { backgroundColor: 'rgba(255, 255, 255, 0.85)' },
};

/* ---------- Buttons ---------- */

type ButtonVariant = 'glass' | 'primary' | 'danger';

export function Button({
  label,
  onPress,
  variant = 'glass',
  icon,
  disabled,
  busy,
  busyLabel,
  style,
  textStyle,
  testID,
  accessibilityLabel,
  accessibilityHint,
  height = 52,
}: {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  icon?: IconName;
  disabled?: boolean;
  busy?: boolean;
  busyLabel?: string;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  testID?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  height?: number;
}) {
  const ink = variant === 'primary' ? WARM.peachInk : variant === 'danger' ? '#fff' : WARM.ink;
  const inactive = Boolean(disabled || busy);
  return (
    <Pressable
      accessibilityHint={accessibilityHint}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy: Boolean(busy) }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { height },
        !isWeb && nativeButton[variant],
        inactive && styles.inactive,
        pressed && styles.pressed,
        style,
      ]}
      testID={testID}
      {...rw(variant === 'glass' ? 'btn' : variant)}
    >
      {icon && !busy ? <Icon color={ink} name={icon} size={18} /> : null}
      <Text style={[styles.buttonText, { color: ink }, textStyle]}>
        {busy && busyLabel ? busyLabel : label}
      </Text>
    </Pressable>
  );
}

const nativeButton: Record<ButtonVariant, ViewStyle> = {
  glass: { backgroundColor: 'rgba(255, 255, 255, 0.6)' },
  primary: { backgroundColor: '#ffb784' },
  danger: { backgroundColor: WARM.danger },
};

/** An underlined text button (the design's `.up-link`), with a 44 pt tap area. */
export function TextLink({
  label,
  onPress,
  color = WARM.ink,
  size = 13,
  testID,
  accessibilityLabel,
  style,
}: {
  label: string;
  onPress: () => void;
  color?: string;
  size?: number;
  testID?: string;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
      onPress={onPress}
      style={({ pressed }) => [styles.link, pressed && styles.pressed, style]}
      testID={testID}
    >
      <Text style={[styles.linkText, { color, fontSize: size }]}>{label}</Text>
    </Pressable>
  );
}

/** A round glass icon button: Back in sub-screens, Close on dark screens. */
export function IconButton({
  icon,
  label,
  onPress,
  dark,
  size = 40,
  testID,
  disabled,
  filled,
}: {
  icon: IconName;
  label: string;
  onPress?: () => void;
  dark?: boolean;
  size?: number;
  testID?: string;
  disabled?: boolean;
  filled?: boolean;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      hitSlop={size < 44 ? (44 - size) / 2 : undefined}
      onPress={onPress}
      style={({ pressed }) => [
        styles.iconButton,
        { width: size, height: size, borderRadius: size / 2 },
        !isWeb && (dark ? styles.darkGlassNative : styles.softNative),
        disabled && styles.inactive,
        pressed && styles.pressed,
      ]}
      testID={testID}
      {...rw(dark ? 'dark-glass' : 'soft')}
    >
      <Icon color={dark ? '#fff' : WARM.ink} filled={filled} name={icon} size={dark ? 22 : 20} />
    </Pressable>
  );
}

/* ---------- Text ---------- */

export function SectionLabel({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<TextStyle>;
}) {
  return (
    <Text accessibilityRole="header" style={[styles.sectionLabel, style]}>
      {children}
    </Text>
  );
}

export function Lead({
  children,
  style,
  testID,
}: {
  children: ReactNode;
  style?: StyleProp<TextStyle>;
  testID?: string;
}) {
  return (
    <Text style={[styles.lead, style]} testID={testID}>
      {children}
    </Text>
  );
}

export function Foot({
  children,
  style,
  testID,
}: {
  children: ReactNode;
  style?: StyleProp<TextStyle>;
  testID?: string;
}) {
  return (
    <Text style={[styles.foot, style]} testID={testID}>
      {children}
    </Text>
  );
}

/** The error line under a form (the design's `.set-err`), announced when it changes. */
export function ErrorText({
  children,
  testID,
  style,
}: {
  children?: ReactNode;
  testID?: string;
  style?: StyleProp<TextStyle>;
}) {
  if (!children) return <View style={styles.errorSpace} />;
  return (
    <Text
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      style={[styles.error, style]}
      testID={testID}
    >
      {children}
    </Text>
  );
}

/* ---------- Fields ---------- */

export const Field = forwardRef<
  TextInput,
  TextInputProps & {
    label: string;
    mono?: boolean;
    containerStyle?: StyleProp<ViewStyle>;
    containerTestID?: string;
  }
>(function Field({ label, mono, style, containerStyle, containerTestID, ...props }, ref) {
  return (
    <Glass style={[styles.field, containerStyle]} testID={containerTestID}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        accessibilityLabel={props.accessibilityLabel ?? label}
        placeholderTextColor="rgba(51, 35, 26, 0.5)"
        ref={ref}
        {...props}
        style={[styles.fieldInput, mono && styles.fieldMono, style]}
        {...rw('bare')}
      />
    </Glass>
  );
});

/* ---------- Lists ---------- */

export function ListGroup({
  children,
  style,
  testID,
  accessibilityLabel,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  accessibilityLabel?: string;
}) {
  return (
    <Glass accessibilityLabel={accessibilityLabel} style={[styles.list, style]} testID={testID}>
      {children}
    </Glass>
  );
}

export function ListRow({
  icon,
  label,
  note,
  onPress,
  chevron,
  danger,
  disabled,
  off,
  selected,
  first,
  leading,
  trailing,
  testID,
  accessibilityLabel,
  accessibilityHint,
  accessibilityRole = 'button',
  accessibilityState,
  noteColor,
}: {
  icon?: IconName;
  label: string;
  note?: string | null;
  onPress?: () => void;
  chevron?: boolean;
  danger?: boolean;
  disabled?: boolean;
  /** Read-only row that looks like the others (members see the owner's settings). */
  off?: boolean;
  selected?: boolean;
  first?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
  testID?: string;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityRole?: PressableProps['accessibilityRole'];
  accessibilityState?: PressableProps['accessibilityState'];
  noteColor?: string;
}) {
  const ink = danger ? WARM.dangerInk : WARM.ink;
  const body = (
    <>
      {leading ??
        (icon ? (
          <Icon
            color={danger ? WARM.dangerInk : off ? WARM.muted : WARM.accent}
            name={icon}
            size={20}
          />
        ) : null)}
      <View style={styles.rowText}>
        <Text style={[styles.rowLabel, { color: ink }]}>{label}</Text>
        {note ? (
          <Text style={[styles.rowNote, noteColor ? { color: noteColor } : null]}>{note}</Text>
        ) : null}
      </View>
      {trailing}
      {selected ? <Icon color={WARM.accent} name="check" size={20} strokeWidth={2.4} /> : null}
      {chevron ? (
        <View style={styles.chevron}>
          <Icon color={WARM.muted} name="chev" size={16} />
        </View>
      ) : null}
    </>
  );
  return (
    <View>
      {first ? null : <View style={styles.rowRule} />}
      {onPress && !off ? (
        <Pressable
          accessibilityHint={accessibilityHint}
          accessibilityLabel={accessibilityLabel}
          accessibilityRole={accessibilityRole}
          accessibilityState={{ disabled: Boolean(disabled), ...accessibilityState }}
          disabled={disabled}
          onPress={onPress}
          style={({ pressed }) => [
            styles.row,
            disabled && styles.inactive,
            pressed && styles.rowPressed,
          ]}
          testID={testID}
        >
          {body}
        </Pressable>
      ) : (
        <View accessibilityLabel={accessibilityLabel} accessible style={styles.row} testID={testID}>
          {body}
        </View>
      )}
    </View>
  );
}

export function ListHint({
  children,
  first,
  testID,
}: {
  children: ReactNode;
  first?: boolean;
  testID?: string;
}) {
  return (
    <View>
      {first ? null : <View style={styles.rowRule} />}
      <Text style={styles.listHint} testID={testID}>
        {children}
      </Text>
    </View>
  );
}

/* ---------- Switch ---------- */

export function Switch({
  value,
  onValueChange,
  label,
  disabled,
  testID,
}: {
  value: boolean;
  onValueChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled: Boolean(disabled) }}
      disabled={disabled}
      hitSlop={8}
      onPress={() => onValueChange(!value)}
      style={[styles.switch, value && styles.switchOn, disabled && styles.inactive]}
      testID={testID}
    >
      <View style={[styles.knob, value && styles.knobOn]} />
    </Pressable>
  );
}

/* ---------- Avatars ---------- */

export function Avatar({
  name,
  color,
  size = 40,
  glass,
  style,
}: {
  name: string;
  color?: string;
  size?: number;
  /** The plain glass avatar in the header, without a member colour. */
  glass?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const initial = (name.trim()[0] ?? '?').toUpperCase();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.avatar,
        { width: size, height: size, borderRadius: size / 2 },
        color
          ? { backgroundColor: tint(color, 38), borderColor: color, borderWidth: 1.5 }
          : glass
            ? !isWeb && styles.softNative
            : { backgroundColor: WARM.avBg },
        style,
      ]}
      {...(glass && !color ? rw('soft') : {})}
    >
      <Text
        style={[
          styles.avatarText,
          { fontSize: size * 0.38, color: color || glass ? WARM.ink : WARM.avInk },
        ]}
      >
        {initial}
      </Text>
    </View>
  );
}

/* ---------- Progress ---------- */

export function ProgressBar({
  slow,
  label,
  width = 180,
}: {
  slow?: boolean;
  label?: string;
  width?: number | '100%';
}) {
  return (
    <View
      accessibilityLabel={label}
      accessibilityRole={label ? 'progressbar' : undefined}
      style={[styles.bar, { width }]}
    >
      <View
        style={[styles.barFill, slow && { opacity: 0.6 }]}
        {...({ dataSet: { rw: 'slide', slow: String(Boolean(slow)) } } as object)}
      />
    </View>
  );
}

/* ---------- Scroll container for pushed screens ---------- */

const NO_INSETS = { top: 0, bottom: 0, left: 0, right: 0 };

/** Safe-area insets, or zero when no SafeAreaProvider is mounted (tests, previews). */
export function useInsets() {
  return useContext(SafeAreaInsetsContext) ?? NO_INSETS;
}

export function useScreenInsets() {
  const insets = useInsets();
  return {
    top: Math.max(insets.top, 10),
    bottom: Math.max(insets.bottom, 12),
    left: insets.left,
    right: insets.right,
  };
}

export const ScreenScroll = forwardRef<ScrollView, ScrollViewProps & { bottomPad?: number }>(
  function ScreenScroll({ children, contentContainerStyle, bottomPad = 40, ...props }, ref) {
    const insets = useScreenInsets();
    return (
      <ScrollView
        keyboardShouldPersistTaps="handled"
        ref={ref}
        showsVerticalScrollIndicator={false}
        {...props}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingTop: insets.top, paddingBottom: insets.bottom + bottomPad },
          contentContainerStyle,
        ]}
        style={[styles.fill, props.style]}
        {...rw('no-scrollbar')}
      >
        {children}
      </ScrollView>
    );
  },
);

/** Header of a pushed screen: Back on the left, a serif title in the middle. */
export function SubHeader({
  title,
  onBack,
  backLabel = 'Back',
  backTestID,
  right,
}: {
  title: string;
  onBack?: () => void;
  backLabel?: string;
  backTestID?: string;
  right?: ReactNode;
}) {
  return (
    <View style={styles.subHeader}>
      <View style={styles.subSide}>
        {onBack ? (
          <IconButton icon="back" label={backLabel} onPress={onBack} testID={backTestID} />
        ) : null}
      </View>
      <Text accessibilityRole="header" numberOfLines={1} style={styles.subTitle}>
        {title}
      </Text>
      <View style={[styles.subSide, styles.subRight]}>{right}</View>
    </View>
  );
}

/* ---------- Dialog ---------- */

/** A bottom card over a dimmed, blurred screen. Tapping the dim cancels, unless `onDismiss` is omitted. */
export function Dialog({
  label,
  title,
  body,
  children,
  onDismiss,
  testID,
  style,
}: {
  label: string;
  title?: string;
  body?: ReactNode;
  children?: ReactNode;
  onDismiss?: () => void;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const insets = useInsets();
  useEffect(() => {
    if (!isWeb || !onDismiss || typeof window === 'undefined') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);
  // Web keyboard modality: the rest of the page goes inert, focus moves into
  // the dialog and returns to the control that opened it.
  const layerRef = useRef<View>(null);
  useEffect(() => {
    const node = layerRef.current as unknown as HTMLElement | null;
    if (!isWeb || typeof document === 'undefined' || !node) return;
    const opener = document.activeElement as HTMLElement | null;
    const others = Array.from(document.body.children).filter(
      (element): element is HTMLElement =>
        element !== node && element instanceof HTMLElement && !element.inert,
    );
    for (const element of others) element.inert = true;
    node
      .querySelector<HTMLElement>(
        '[role="dialog"] input, [role="dialog"] textarea, [role="dialog"] [tabindex="0"]',
      )
      ?.focus();
    return () => {
      for (const element of others) element.inert = false;
      opener?.focus?.();
    };
  }, []);
  const layer = (
    <View
      ref={layerRef}
      style={[StyleSheet.absoluteFill, isWeb && styles.dialogLayerWeb]}
      testID={testID ? `${testID}-layer` : undefined}
    >
      <Pressable
        accessibilityLabel={onDismiss ? 'Dismiss' : undefined}
        accessible={Boolean(onDismiss)}
        disabled={!onDismiss}
        onPress={onDismiss}
        style={[StyleSheet.absoluteFill, !isWeb && styles.dimNative]}
        {...rw('dim fade-in')}
      />
      <Glass
        accessibilityLabel={label}
        accessibilityViewIsModal
        aria-modal
        role="dialog"
        style={[styles.dialog, { bottom: Math.max(insets.bottom, 12) + 22 }, style]}
        extra="dlg-in"
        testID={testID}
        variant="dialog"
      >
        {title ? (
          <Text accessibilityRole="header" style={styles.dialogTitle}>
            {title}
          </Text>
        ) : null}
        {typeof body === 'string' ? <Text style={styles.dialogBody}>{body}</Text> : body}
        {children}
      </Glass>
    </View>
  );
  // On the web every view is its own stacking context, so a dialog opened inside
  // a tab would sit under the dock. Render it on the page itself instead.
  return isWeb && typeof document !== 'undefined' ? createPortal(layer, document.body) : layer;
}

/* ---------- Toast ---------- */

const ToastContext = createContext<(text: string) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ text: string; id: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const insets = useInsets();
  const show = useCallback((text: string) => {
    if (timer.current) clearTimeout(timer.current);
    setToast((current) => ({ text, id: (current?.id ?? 0) + 1 }));
    timer.current = setTimeout(() => setToast(null), MOTION.toast);
  }, []);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <ToastContext.Provider value={show}>
      <View style={styles.fill}>
        {children}
        <View
          pointerEvents="none"
          style={[styles.toastLayer, { bottom: Math.max(insets.bottom, 12) + 96 }]}
        >
          {toast ? (
            <Text
              accessibilityLiveRegion="polite"
              accessibilityRole="alert"
              key={toast.id}
              style={styles.toast}
              testID="app-toast"
              {...rw('toast')}
            >
              {toast.text}
            </Text>
          ) : null}
        </View>
      </View>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

/* ---------- Small helpers ---------- */

/** Re-run a one-off CSS effect (roll, nope, tip) by changing the key it is mounted with. */
export function useEffectKey() {
  const [key, setKey] = useState(0);
  const fire = useCallback(() => setKey((value) => value + 1), []);
  return [key, fire] as const;
}

/** The current time, refreshed every minute, for countdowns drawn during render. */
export function useNow(intervalMs = 60_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export const styles = StyleSheet.create({
  fill: { flex: 1 },
  glow: {
    position: 'absolute',
    left: '50%',
    width: 560,
    height: 560,
    marginLeft: -280,
  },
  glowNative: {
    backgroundColor: 'rgba(255, 186, 130, 0.28)',
    borderRadius: 280,
    transform: [{ scale: 0.7 }],
  },
  glowLow: { position: 'absolute', left: -60, right: -60, bottom: 0, height: 460 },
  glass: { borderRadius: 30 },
  button: {
    alignItems: 'center',
    borderRadius: 999,
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    paddingHorizontal: 18,
    width: '100%',
  },
  buttonText: { fontFamily: FONT.body, fontSize: 15, fontWeight: '600' },
  inactive: { opacity: 0.5 },
  pressed: { opacity: 0.82, transform: [{ scale: 0.98 }] },
  link: { alignSelf: 'center', minHeight: 24, justifyContent: 'center' },
  linkText: {
    fontFamily: FONT.body,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
  iconButton: { alignItems: 'center', justifyContent: 'center' },
  softNative: { backgroundColor: 'rgba(255, 255, 255, 0.7)' },
  darkGlassNative: { backgroundColor: 'rgba(255, 255, 255, 0.16)' },
  sectionLabel: {
    color: WARM.muted,
    fontFamily: FONT.body,
    fontSize: 11.5,
    letterSpacing: 1.4,
    marginBottom: 8,
    marginHorizontal: 6,
    marginTop: 22,
    textTransform: 'uppercase',
  },
  lead: {
    color: WARM.muted,
    fontFamily: FONT.body,
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 16,
    marginHorizontal: 6,
  },
  foot: {
    color: WARM.muted,
    fontFamily: FONT.body,
    fontSize: 12,
    marginTop: 22,
    textAlign: 'center',
  },
  error: {
    color: WARM.dangerInk,
    fontFamily: FONT.body,
    fontSize: 12.5,
    marginBottom: 10,
    marginHorizontal: 6,
    marginTop: 8,
    minHeight: 18,
  },
  errorSpace: { height: 36 },
  field: { borderRadius: 18, gap: 6, marginBottom: 10, paddingHorizontal: 16, paddingVertical: 12 },
  fieldLabel: { color: WARM.muted, fontFamily: FONT.body, fontSize: 12 },
  fieldInput: {
    color: WARM.ink,
    fontFamily: FONT.body,
    fontSize: 18,
    minHeight: 26,
    padding: 0,
  },
  fieldMono: { fontFamily: FONT.monoMedium, fontSize: 22, letterSpacing: 2.2 },
  list: { borderRadius: 22, paddingVertical: 2 },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  rowRule: {
    backgroundColor: WARM.line,
    height: 1,
    left: 48,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  rowPressed: { backgroundColor: 'rgba(51, 35, 26, 0.05)' },
  rowText: { flex: 1, gap: 2 },
  rowLabel: { fontFamily: FONT.body, fontSize: 15 },
  rowNote: { color: WARM.muted, fontFamily: FONT.body, fontSize: 12.5, lineHeight: 16 },
  chevron: { transform: [{ rotate: '-90deg' }] },
  listHint: {
    color: WARM.muted,
    fontFamily: FONT.body,
    fontSize: 12.5,
    lineHeight: 17,
    paddingBottom: 12,
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  switch: {
    backgroundColor: 'rgba(51, 35, 26, 0.16)',
    borderRadius: 999,
    height: 30,
    justifyContent: 'center',
    paddingHorizontal: 3,
    width: 50,
  },
  switchOn: { backgroundColor: WARM.accent },
  knob: {
    backgroundColor: '#fff',
    borderRadius: 12,
    boxShadow: '0 2px 6px rgba(0, 0, 0, 0.2)',
    height: 24,
    width: 24,
  },
  knobOn: { transform: [{ translateX: 20 }] },
  avatar: { alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontFamily: FONT.body, fontWeight: '600' },
  bar: {
    backgroundColor: WARM.line,
    borderRadius: 4,
    height: 4,
    marginTop: 8,
    overflow: 'hidden',
  },
  barFill: {
    backgroundColor: WARM.accent,
    borderRadius: 4,
    bottom: 0,
    left: 0,
    position: 'absolute',
    top: 0,
    width: '35%',
  },
  scrollContent: {
    alignSelf: 'center',
    maxWidth: LAYOUT.maxWidth,
    paddingHorizontal: LAYOUT.gutter,
    width: '100%',
  },
  subHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    height: 56,
    marginBottom: 14,
  },
  subSide: { width: 44 },
  subRight: { alignItems: 'flex-end' },
  subTitle: { color: WARM.ink, flex: 1, textAlign: 'center', ...serif(22) },
  dimNative: { backgroundColor: 'rgba(40, 24, 14, 0.4)' },
  // 'fixed' is web-only, so it is outside React Native's style types.
  dialogLayerWeb: { position: 'fixed' as 'absolute', zIndex: 50 },
  dialog: {
    gap: 10,
    left: 22,
    paddingBottom: 18,
    paddingHorizontal: 18,
    paddingTop: 22,
    position: 'absolute',
    right: 22,
    alignSelf: 'center',
    maxWidth: LAYOUT.maxWidth - 44,
  },
  dialogTitle: { color: WARM.ink, textAlign: 'center', ...serif(22) },
  dialogBody: {
    color: WARM.muted,
    fontFamily: FONT.body,
    fontSize: 13.5,
    lineHeight: 19.5,
    marginBottom: 8,
    textAlign: 'center',
  },
  toastLayer: { alignItems: 'center', left: 16, position: 'absolute', right: 16, zIndex: 80 },
  toast: {
    backgroundColor: '#1d1b18',
    borderRadius: 10,
    color: '#f4f1eb',
    fontFamily: FONT.body,
    fontSize: 13,
    maxWidth: 360,
    overflow: 'hidden',
    paddingHorizontal: 16,
    paddingVertical: 9,
    textAlign: 'center',
  },
});

export { DARK };
