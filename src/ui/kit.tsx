import type { ReactNode } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type AccessibilityRole,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { COLORS, SPACE } from '../theme';

/**
 * Concept A ("Today's moment") building blocks. Callers pass already
 * translated copy so the same parts render in English or Chinese.
 */

export function Eyebrow({ children, testID }: { children: ReactNode; testID?: string }) {
  return (
    <Text style={styles.eyebrow} testID={testID}>
      {children}
    </Text>
  );
}

export function ScreenIntro({
  body,
  eyebrow,
  headingTestID,
  title,
}: {
  body?: string;
  eyebrow: string;
  headingTestID?: string;
  title: string;
}) {
  return (
    <View style={styles.intro}>
      <Eyebrow>{eyebrow}</Eyebrow>
      <Text accessibilityRole="header" style={styles.title} testID={headingTestID}>
        {title}
      </Text>
      {body ? <Text style={styles.quiet}>{body}</Text> : null}
    </View>
  );
}

export function Quiet({ children, testID }: { children: ReactNode; testID?: string }) {
  return (
    <Text style={styles.quiet} testID={testID}>
      {children}
    </Text>
  );
}

export function Micro({ children, testID }: { children: ReactNode; testID?: string }) {
  return (
    <Text style={styles.micro} testID={testID}>
      {children}
    </Text>
  );
}

export function Separator() {
  return <View accessible={false} style={styles.separator} />;
}

export function Panel({
  accessibilityLabel,
  body,
  children,
  eyebrow,
  live,
  style,
  testID,
  title,
  tone = 'default',
}: {
  accessibilityLabel?: string;
  body?: ReactNode;
  children?: ReactNode;
  eyebrow?: string;
  live?: 'polite' | 'assertive';
  style?: StyleProp<ViewStyle>;
  testID?: string;
  title?: string;
  tone?: 'default' | 'alert';
}) {
  return (
    <View
      accessibilityLabel={accessibilityLabel}
      style={[styles.panel, tone === 'alert' && styles.alertPanel, style]}
      testID={testID}
    >
      {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
      {title ? (
        <Text accessibilityLiveRegion={live} style={styles.panelTitle}>
          {title}
        </Text>
      ) : null}
      {typeof body === 'string' ? <Text style={styles.quiet}>{body}</Text> : body}
      {children}
    </View>
  );
}

export function ActionButton({
  accessibilityHint,
  accessibilityLabel,
  busy = false,
  disabled = false,
  full = false,
  label,
  onPress,
  role = 'button',
  selected,
  testID,
  variant = 'secondary',
}: {
  accessibilityHint?: string;
  accessibilityLabel?: string;
  busy?: boolean;
  disabled?: boolean;
  full?: boolean;
  label: string;
  onPress?: () => void | Promise<void>;
  role?: AccessibilityRole;
  selected?: boolean;
  testID?: string;
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
}) {
  const inactive = disabled || busy;
  return (
    <Pressable
      accessibilityHint={accessibilityHint}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={role}
      accessibilityState={{ busy, disabled: inactive, selected }}
      disabled={inactive}
      onPress={onPress ? () => void onPress() : undefined}
      style={({ pressed }) => [
        styles.button,
        variant === 'primary' && styles.primary,
        variant === 'quiet' && styles.quietButton,
        variant === 'danger' && styles.danger,
        selected && styles.selectedButton,
        full && styles.full,
        inactive && styles.disabled,
        pressed && !inactive && styles.pressed,
      ]}
      testID={testID}
    >
      <Text
        style={[
          styles.buttonText,
          variant === 'primary' && styles.primaryText,
          variant === 'quiet' && styles.quietButtonText,
          variant === 'danger' && styles.dangerText,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function ButtonRow({ children }: { children: ReactNode }) {
  return <View style={styles.buttonRow}>{children}</View>;
}

export function Stats({
  accessibilityLabel,
  items,
  testID,
}: {
  accessibilityLabel: string;
  items: { value: string; caption: string; testID?: string }[];
  testID?: string;
}) {
  return (
    <View accessible accessibilityLabel={accessibilityLabel} style={styles.stats} testID={testID}>
      {items.map((item) => (
        <View key={item.caption} style={styles.stat}>
          <Text style={styles.statValue} testID={item.testID}>
            {item.value}
          </Text>
          <Text style={styles.statCaption}>{item.caption}</Text>
        </View>
      ))}
    </View>
  );
}

/** Dashed seal card: status in words with a shape marker, never colour alone. */
export function SealCard({
  accessibilityLabel,
  action,
  body,
  children,
  label,
  testID,
  title,
}: {
  accessibilityLabel?: string;
  action?: ReactNode;
  body: string;
  children?: ReactNode;
  label?: string;
  testID?: string;
  title: string;
}) {
  return (
    <View
      accessibilityLabel={accessibilityLabel ?? `${title}. ${body}`}
      accessible={false}
      style={styles.seal}
      testID={testID}
    >
      {label ? <Eyebrow>{label}</Eyebrow> : null}
      <View style={styles.statusName}>
        <View accessible={false} style={styles.statusDot} />
        <Text accessibilityRole="header" style={styles.statusTitle}>
          {title}
        </Text>
      </View>
      <Text accessibilityLiveRegion="polite" style={styles.quiet}>
        {body}
      </Text>
      {children}
      {action}
    </View>
  );
}

export function ActorLine({ caption, name }: { caption: string; name: string }) {
  return (
    <View accessible accessibilityLabel={`${name}, ${caption}`} style={styles.person}>
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>{name.slice(0, 1).toUpperCase()}</Text>
      </View>
      <Text style={styles.personText}>
        {name} · {caption}
      </Text>
    </View>
  );
}

export function InlineError({ children, testID }: { children: ReactNode; testID?: string }) {
  return (
    <View style={styles.error} testID={testID}>
      <Text accessibilityLiveRegion="assertive" accessibilityRole="alert" style={styles.errorText}>
        {children}
      </Text>
    </View>
  );
}

export function Notice({ children, testID }: { children: ReactNode; testID?: string }) {
  return (
    <View style={styles.error} testID={testID}>
      <Text accessibilityLiveRegion="polite" style={styles.errorText}>
        {children}
      </Text>
    </View>
  );
}

export function StepLine({
  accessibilityLabel,
  active,
  steps,
}: {
  accessibilityLabel: string;
  active: number;
  steps: string[];
}) {
  return (
    <View accessible accessibilityLabel={accessibilityLabel} style={styles.stepLine}>
      {steps.map((step, index) => (
        <Text
          key={step}
          style={[styles.step, index === active && styles.stepActive]}
        >{`${index > 0 ? '→ ' : ''}${step}`}</Text>
      ))}
    </View>
  );
}

export function MockMedia({
  caption,
  kind,
  testID,
  title,
}: {
  caption: string;
  kind: 'still' | 'clip';
  testID?: string;
  title: string;
}) {
  return (
    <View
      accessible
      accessibilityLabel={`${title}. ${caption}`}
      style={styles.mockMedia}
      testID={testID}
    >
      <View style={styles.mockOutline}>
        <Text style={styles.mockGlyph}>{kind === 'clip' ? '▷' : '+'}</Text>
      </View>
      <Text style={styles.mockTitle}>{title}</Text>
      <Text style={styles.micro}>{caption}</Text>
    </View>
  );
}

export const kitStyles = StyleSheet.create({
  scroll: { flex: 1 },
  content: {
    flexGrow: 1,
    gap: SPACE.section,
    paddingBottom: 32,
    paddingHorizontal: SPACE.page,
    paddingTop: 22,
  },
});

const styles = StyleSheet.create({
  eyebrow: {
    color: COLORS.muted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.4,
  },
  intro: { gap: 6 },
  title: {
    color: COLORS.ink,
    fontSize: 27,
    fontWeight: '600',
    letterSpacing: -0.6,
    lineHeight: 33,
  },
  quiet: { color: COLORS.muted, fontSize: 14, lineHeight: 21 },
  micro: { color: COLORS.muted, fontSize: 12, lineHeight: 18 },
  separator: { backgroundColor: COLORS.line, height: 1, marginVertical: 6 },
  panel: {
    backgroundColor: COLORS.paper,
    borderColor: COLORS.line,
    borderRadius: 9,
    borderWidth: 1,
    gap: 10,
    padding: SPACE.panel,
  },
  alertPanel: { borderColor: COLORS.accent, borderLeftWidth: 3 },
  panelTitle: { color: COLORS.ink, fontSize: 19, fontWeight: '700', lineHeight: 25 },
  button: {
    alignItems: 'center',
    backgroundColor: 'transparent',
    borderColor: COLORS.line,
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  primary: { backgroundColor: COLORS.accent, borderColor: COLORS.accent },
  quietButton: { borderColor: 'transparent', minHeight: 44 },
  danger: { borderColor: COLORS.accent },
  selectedButton: { backgroundColor: COLORS.deep, borderColor: COLORS.accent },
  full: { alignSelf: 'stretch' },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.82 },
  buttonText: { color: COLORS.ink, fontSize: 15, fontWeight: '600', textAlign: 'center' },
  primaryText: { color: COLORS.accentInk, fontWeight: '700' },
  quietButtonText: { color: COLORS.muted, textDecorationLine: 'underline' },
  dangerText: { color: COLORS.accent },
  buttonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  stats: { flexDirection: 'row', gap: 12, marginVertical: 4 },
  stat: {
    borderLeftColor: COLORS.line,
    borderLeftWidth: 2,
    flex: 1,
    gap: 2,
    paddingLeft: 10,
  },
  statValue: { color: COLORS.ink, fontSize: 18, fontWeight: '500' },
  statCaption: { color: COLORS.muted, fontSize: 11, lineHeight: 16 },
  seal: {
    borderColor: COLORS.line,
    borderRadius: 8,
    borderStyle: 'dashed',
    borderWidth: 1,
    gap: 10,
    padding: SPACE.panel,
  },
  statusName: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  statusDot: {
    borderColor: COLORS.ink,
    borderRadius: 4,
    borderWidth: 1,
    height: 8,
    width: 8,
  },
  statusTitle: { color: COLORS.ink, flexShrink: 1, fontSize: 15, fontWeight: '700' },
  person: { alignItems: 'center', flexDirection: 'row', gap: 10 },
  avatar: {
    alignItems: 'center',
    borderColor: COLORS.line,
    borderRadius: 14,
    borderWidth: 1,
    height: 28,
    justifyContent: 'center',
    width: 28,
  },
  avatarText: { color: COLORS.ink, fontSize: 12, fontWeight: '700' },
  personText: { color: COLORS.muted, flexShrink: 1, fontSize: 12 },
  error: {
    backgroundColor: COLORS.paper,
    borderLeftColor: COLORS.accent,
    borderLeftWidth: 3,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  errorText: { color: COLORS.ink, fontSize: 13, lineHeight: 19 },
  stepLine: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  step: { color: COLORS.muted, fontSize: 11 },
  stepActive: { color: COLORS.ink, fontWeight: '700' },
  mockMedia: {
    alignItems: 'center',
    aspectRatio: 4 / 3,
    backgroundColor: COLORS.paper,
    borderColor: COLORS.line,
    borderWidth: 1,
    gap: 9,
    justifyContent: 'center',
    padding: 20,
  },
  mockOutline: {
    alignItems: 'center',
    borderColor: COLORS.muted,
    borderStyle: 'dashed',
    borderWidth: 1,
    height: 42,
    justifyContent: 'center',
    width: 56,
  },
  mockGlyph: { color: COLORS.ink, fontSize: 22 },
  mockTitle: { color: COLORS.ink, fontSize: 14, fontWeight: '700', textAlign: 'center' },
});
