import { Platform, StyleSheet, Text, View } from 'react-native';
import { COLORS } from '../theme';

/** A compact film-edge marker shared by the working areas of the Darkroom. */
export function DarkroomSection({ label }: { label: string }) {
  return (
    <View style={styles.section}>
      <Text style={styles.label}>{label}</Text>
      <View
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={styles.edge}
      >
        {Array.from({ length: 6 }, (_, index) => (
          <View key={index} style={styles.hole} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.filmBorder,
    paddingBottom: 10,
    marginBottom: 10,
    flexWrap: 'wrap',
  },
  label: {
    color: COLORS.filmAmber,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1.5,
  },
  edge: { flexDirection: 'row', gap: 5 },
  hole: { width: 7, height: 5, borderWidth: 1, borderColor: COLORS.filmBorder, borderRadius: 1 },
});
