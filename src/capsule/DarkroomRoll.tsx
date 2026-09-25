import { Platform, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { COLORS } from '../theme';

export function DarkroomRoll({ seconds, released }: { seconds: number; released: boolean }) {
  const { width } = useWindowDimensions();
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return (
    <View style={styles.stack}>
      {!released && seconds > 0 ? (
        <View
          accessible
          accessibilityLabel={`${days} days, ${hours} hours and ${minutes} minutes left in collection`}
          style={styles.clock}
        >
          <View>
            <Text style={styles.number}>{String(days > 0 ? days : hours).padStart(2, '0')}</Text>
            <Text style={styles.label}>{days > 0 ? 'DAYS' : 'HOURS'}</Text>
          </View>
          <Text style={styles.colon}>:</Text>
          <View>
            <Text style={styles.number}>{String(days > 0 ? hours : minutes).padStart(2, '0')}</Text>
            <Text style={styles.label}>{days > 0 ? 'HOURS' : 'MINUTES'}</Text>
          </View>
        </View>
      ) : null}
      <View style={styles.stage}>
        <View
          style={styles.film}
          testID="darkroom-filmstrip"
          accessible
          accessibilityLabel={
            released
              ? 'Released film illustration. Open Archive to watch.'
              : 'Illustrative sealed film frames. No media previews or contribution count.'
          }
        >
          <LinearGradient
            pointerEvents="none"
            colors={['#C8502159', '#C8502100', '#C8502100', '#C8502138']}
            locations={[0, 0.08, 0.96, 1]}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            style={StyleSheet.absoluteFill}
          />
          <LinearGradient
            pointerEvents="none"
            colors={['#D8C8A200', '#D8C8A224', '#D8C8A208', '#D8C8A200', '#100F1142']}
            locations={[0.12, 0.18, 0.29, 0.43, 1]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0.55 }}
            style={StyleSheet.absoluteFill}
          />
          <View style={[styles.holes, width < 380 && styles.compactHoles]}>
            {Array.from({ length: 13 }, (_, i) => (
              <View key={i} style={styles.hole} />
            ))}
          </View>
          <View style={styles.edge}>
            <Text style={styles.label}>REWIND 400</Text>
            <Text style={styles.label}>CURRENT ROLL</Text>
          </View>
          <View style={styles.frames}>
            {[1, 2, 3].map((n) => (
              <View key={n} style={styles.frame}>
                <LinearGradient
                  pointerEvents="none"
                  colors={['#514032', COLORS.filmFrame, '#141211']}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={StyleSheet.absoluteFill}
                />
                <View pointerEvents="none" style={styles.frameInset} />
                <View pointerEvents="none" style={styles.frameHighlight} />
                {released ? (
                  <View accessible={false} style={styles.playRing}>
                    <View style={styles.playTriangle} />
                  </View>
                ) : (
                  <View accessible={false} style={styles.lock}>
                    <View style={styles.shackle} />
                    <View style={styles.lockBody}>
                      <View style={styles.keyhole} />
                    </View>
                  </View>
                )}
                <Text style={styles.label}>{released ? 'RELEASED' : 'SEALED'}</Text>
              </View>
            ))}
          </View>
          <View style={styles.frames}>
            {[1, 2, 3].map((n) => (
              <Text key={n} style={styles.frameNumber}>
                0{n}A ▸
              </Text>
            ))}
          </View>
          <View style={[styles.holes, width < 380 && styles.compactHoles]}>
            {Array.from({ length: 13 }, (_, i) => (
              <View key={i} style={styles.hole} />
            ))}
          </View>
        </View>
      </View>
      <Text style={styles.caption}>Sealed roll illustration · no media previews</Text>
    </View>
  );
}
const styles = StyleSheet.create({
  stage: { paddingVertical: 20, marginHorizontal: -24, overflow: 'hidden' },
  frameInset: {
    position: 'absolute',
    inset: 5,
    borderColor: COLORS.filmAmber,
    borderWidth: 0.5,
    opacity: 0.3,
  },
  frameHighlight: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: 2,
    backgroundColor: COLORS.filmAmber,
    opacity: 0.12,
  },
  frameNumber: {
    flex: 1,
    color: COLORS.filmAmber,
    fontSize: 10,
    letterSpacing: 1.5,
    textAlign: 'center',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  playRing: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1.8,
    borderColor: COLORS.filmAmber,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playTriangle: {
    width: 0,
    height: 0,
    marginLeft: 3,
    borderTopWidth: 5,
    borderBottomWidth: 5,
    borderLeftWidth: 8,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    borderLeftColor: COLORS.filmAmber,
  },
  lock: { alignItems: 'center', height: 29, justifyContent: 'flex-end' },
  shackle: {
    position: 'absolute',
    top: 0,
    width: 14,
    height: 17,
    borderColor: COLORS.filmAmber,
    borderWidth: 1.8,
    borderRadius: 8,
  },
  lockBody: {
    width: 25,
    height: 18,
    borderColor: COLORS.filmAmber,
    borderWidth: 1.8,
    borderRadius: 4,
    backgroundColor: COLORS.filmFrame,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyhole: { width: 2, height: 5, backgroundColor: COLORS.filmAmber },
  stack: { gap: 4 },
  clock: { flexDirection: 'row', alignItems: 'center', gap: 16, flexWrap: 'wrap' },
  number: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 58,
    letterSpacing: -3,
    color: COLORS.ink,
  },
  colon: { fontSize: 42, color: COLORS.accent },
  label: { fontSize: 10, letterSpacing: 1, color: COLORS.filmAmber, fontWeight: '600' },
  film: {
    backgroundColor: COLORS.celluloid,
    padding: 8,
    gap: 7,
    marginHorizontal: -22,
    transform: [{ rotate: '-4deg' }],
    borderRadius: 3,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: COLORS.filmBorder,
  },
  holes: { flexDirection: 'row', gap: 9, paddingHorizontal: 2 },
  compactHoles: { gap: 6 },
  hole: {
    flex: 1,
    height: 8,
    borderRadius: 1.5,
    backgroundColor: COLORS.background,
    borderTopWidth: 1,
    borderTopColor: COLORS.deep,
    borderBottomWidth: 0.5,
    borderBottomColor: '#D9B77D80',
  },
  edge: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    paddingHorizontal: 32,
    gap: 6,
  },
  frames: { flexDirection: 'row', gap: 6 },
  frame: {
    flex: 1,
    minHeight: 104,
    padding: 5,
    gap: 10,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: COLORS.filmFrame,
    borderWidth: 1,
    borderColor: COLORS.filmBorder,
  },
  caption: { fontSize: 11, color: COLORS.muted, marginTop: -4 },
});
