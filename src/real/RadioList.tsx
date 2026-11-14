import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { Glass } from '../ui/primitives';
import { FONT, WARM } from '../ui/tokens';

export interface RadioOption {
  value: string;
  label: string;
  testID: string;
}

/**
 * A glass card holding one radio per option (prompt picker, report reasons).
 * `align="top"` pins the radio to the first line of wrapping text; `"center"`
 * centres it. Children render after the options, inside the card.
 */
export function RadioList({
  label,
  options,
  value,
  onChange,
  align = 'top',
  style,
  children,
}: {
  /** Accessibility label of the radiogroup. */
  label: string;
  options: RadioOption[];
  value: string;
  onChange: (value: string) => void;
  align?: 'top' | 'center';
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
}) {
  const centered = align === 'center';
  return (
    <Glass accessibilityLabel={label} role="radiogroup" style={style}>
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            key={option.value}
            onPress={() => onChange(option.value)}
            style={[
              styles.option,
              centered && styles.optionCentered,
              index > 0 && styles.optionRule,
            ]}
            testID={option.testID}
          >
            <View
              style={[styles.radio, centered && styles.radioCentered, selected && styles.radioOn]}
            >
              {selected ? <View style={styles.radioDot} /> : null}
            </View>
            <Text style={styles.optionText}>{option.label}</Text>
          </Pressable>
        );
      })}
      {children}
    </Glass>
  );
}

const styles = StyleSheet.create({
  option: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 12,
    minHeight: 44,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  optionCentered: { alignItems: 'center', paddingVertical: 10 },
  optionRule: { borderTopColor: WARM.line, borderTopWidth: 1 },
  radio: {
    alignItems: 'center',
    borderColor: 'rgba(51, 35, 26, 0.45)',
    borderRadius: 9,
    borderWidth: 1.5,
    height: 18,
    justifyContent: 'center',
    marginTop: 1,
    width: 18,
  },
  radioCentered: { marginTop: 0 },
  radioOn: { borderColor: WARM.accent },
  radioDot: { backgroundColor: WARM.accent, borderRadius: 5, height: 10, width: 10 },
  optionText: { color: WARM.ink, flex: 1, fontFamily: FONT.body, fontSize: 14.5, lineHeight: 19.5 },
});
