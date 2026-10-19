import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Icon } from '../ui/Icon';
import { Button, Dialog, ErrorText, Glass } from '../ui/primitives';
import { FONT, WARM } from '../ui/tokens';

export const REPORT_REASONS = [
  'Sexual or inappropriate',
  'Harassment or bullying',
  'Violence or self-harm',
  'Spam',
  'Something else',
] as const;

/**
 * Report a person, a message or a moment (S17, T11, F4). Moments in the film
 * aren't labelled with who took them, so they have no name and no block.
 */
export function ReportSheet({
  what,
  name,
  onSend,
  onCancel,
}: {
  what: 'person' | 'message' | 'moment';
  /** The person reported, when known. */
  name?: string;
  /** Resolve to an error message to keep the sheet open, or null when sent. */
  onSend: (reason: string, alsoBlock: boolean) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState<string>(REPORT_REASONS[0]);
  const [block, setBlock] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    setPending(true);
    setError(null);
    const failure = await onSend(reason, Boolean(name) && block);
    setPending(false);
    if (failure) setError(failure);
  };
  return (
    <Dialog
      body={`Reports go to the Rewind team${name ? `, not to ${name}` : ''}. We review every one within 24 hours.`}
      label="Report"
      onDismiss={pending ? undefined : onCancel}
      style={styles.sheet}
      testID="report-sheet"
      title={`Report this ${what}`}
    >
      <ScrollView style={styles.scroll}>
        <Glass accessibilityLabel="Reason" role="radiogroup" style={styles.reasons}>
          {REPORT_REASONS.map((item, index) => {
            const selected = item === reason;
            return (
              <Pressable
                accessibilityRole="radio"
                accessibilityState={{ checked: selected }}
                key={item}
                onPress={() => setReason(item)}
                style={[styles.option, index > 0 && styles.optionRule]}
                testID={`report-reason-${index}`}
              >
                <View style={[styles.radio, selected && styles.radioOn]}>
                  {selected ? <View style={styles.radioDot} /> : null}
                </View>
                <Text style={styles.optionText}>{item}</Text>
              </Pressable>
            );
          })}
        </Glass>
        {name ? (
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: block }}
            onPress={() => setBlock((value) => !value)}
            style={styles.check}
            testID="report-also-block"
          >
            <View style={[styles.box, block && styles.boxOn]}>
              {block ? <Icon color="#fff" name="check" size={14} strokeWidth={2.6} /> : null}
            </View>
            <Text style={styles.checkText}>Also block {name}</Text>
          </Pressable>
        ) : null}
      </ScrollView>
      {error ? <ErrorText>{error}</ErrorText> : null}
      <Button
        busy={pending}
        busyLabel="Sending…"
        label="Send report"
        onPress={() => void send()}
        testID="report-send"
        variant="danger"
      />
      <Button disabled={pending} label="Cancel" onPress={onCancel} testID="report-cancel" />
    </Dialog>
  );
}

const styles = StyleSheet.create({
  sheet: { maxHeight: '86%' },
  scroll: { flexGrow: 0 },
  reasons: { borderRadius: 22, marginBottom: 2, paddingVertical: 4 },
  option: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    minHeight: 44,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  optionRule: { borderTopColor: WARM.line, borderTopWidth: 1 },
  radio: {
    alignItems: 'center',
    borderColor: 'rgba(51, 35, 26, 0.45)',
    borderRadius: 9,
    borderWidth: 1.5,
    height: 18,
    justifyContent: 'center',
    width: 18,
  },
  radioOn: { borderColor: WARM.accent },
  radioDot: { backgroundColor: WARM.accent, borderRadius: 5, height: 10, width: 10 },
  optionText: { color: WARM.ink, flex: 1, fontFamily: FONT.body, fontSize: 14.5, lineHeight: 19.5 },
  check: { alignItems: 'center', alignSelf: 'center', flexDirection: 'row', gap: 8, minHeight: 44 },
  box: {
    alignItems: 'center',
    borderColor: 'rgba(51, 35, 26, 0.45)',
    borderRadius: 4,
    borderWidth: 1.5,
    height: 18,
    justifyContent: 'center',
    width: 18,
  },
  boxOn: { backgroundColor: '#e07a5f', borderColor: '#e07a5f' },
  checkText: { color: WARM.ink, fontFamily: FONT.body, fontSize: 13.5 },
});
