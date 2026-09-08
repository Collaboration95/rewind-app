import { useEffect, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { AccessibilityInfo, Animated, Easing, StyleSheet, Text, View } from 'react-native';

const FILM_FRAMES = [
  { glow: '#A6563D', surface: '#3B2927' },
  { glow: '#786079', surface: '#302A32' },
  { glow: '#C48B5A', surface: '#3A302B' },
  { glow: '#55716B', surface: '#28312F' },
];
const FILM_SET_WIDTH = 624;
const PERFORATIONS = Array.from({ length: 6 }, (_, index) => index);

function FilmFrame({ glow, surface }: { glow: string; surface: string }) {
  return (
    <View style={styles.filmCell}>
      <View style={styles.perforationRow}>
        {PERFORATIONS.map((index) => (
          <View key={`top-${index}`} style={styles.perforation} />
        ))}
      </View>
      <View style={[styles.filmFrame, { backgroundColor: surface }]}>
        <View style={[styles.frameGlowLarge, { backgroundColor: glow }]} />
        <View style={[styles.frameGlowSmall, { borderColor: glow }]} />
      </View>
      <View style={styles.perforationRow}>
        {PERFORATIONS.map((index) => (
          <View key={`bottom-${index}`} style={styles.perforation} />
        ))}
      </View>
    </View>
  );
}

function MovingFilmStrip() {
  const [translateX] = useState(() => new Animated.Value(0));
  const [motionEnabled, setMotionEnabled] = useState(false);

  useEffect(() => {
    let isMounted = true;

    void AccessibilityInfo.isReduceMotionEnabled().then((reduceMotion) => {
      if (isMounted) setMotionEnabled(!reduceMotion);
    });

    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      (reduceMotion) => {
        setMotionEnabled(!reduceMotion);
      },
    );

    return () => {
      isMounted = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    translateX.stopAnimation();
    translateX.setValue(0);

    if (!motionEnabled) return undefined;

    const animation = Animated.loop(
      Animated.timing(translateX, {
        duration: 24000,
        easing: Easing.linear,
        toValue: -FILM_SET_WIDTH,
        useNativeDriver: false,
      }),
    );

    animation.start();
    return () => animation.stop();
  }, [motionEnabled, translateX]);

  return (
    <View
      accessibilityElementsHidden
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={styles.filmViewport}
      testID="ambient-film-strip"
    >
      <Animated.View style={[styles.filmTrack, { transform: [{ translateX }] }]}>
        {[...FILM_FRAMES, ...FILM_FRAMES].map((frame, index) => (
          <FilmFrame key={`${frame.surface}-${index}`} {...frame} />
        ))}
      </Animated.View>
    </View>
  );
}

export default function App() {
  return (
    <View style={styles.safeArea}>
      <StatusBar style="light" />
      <View style={styles.content}>
        <View style={styles.topBar}>
          <Text style={styles.brand}>rewind</Text>
          <View accessible accessibilityLabel="Local demo" style={styles.demoBadge}>
            <Text style={styles.demoBadgeText}>LOCAL DEMO</Text>
          </View>
        </View>

        <View style={styles.intro}>
          <Text style={styles.eyebrow}>HOME</Text>
          <Text accessibilityRole="header" style={styles.title}>
            Moments worth waiting for.
          </Text>
        </View>

        <MovingFilmStrip />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    backgroundColor: '#252326',
    flex: 1,
  },
  content: {
    alignSelf: 'center',
    flex: 1,
    gap: 48,
    justifyContent: 'center',
    maxWidth: 760,
    paddingHorizontal: 28,
    paddingVertical: 40,
    width: '100%',
  },
  topBar: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  brand: {
    color: '#F9EBD5',
    fontFamily: 'Consolas',
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -1.2,
  },
  demoBadge: {
    borderColor: '#51474A',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  demoBadgeText: {
    color: '#B9ABA0',
    fontFamily: 'Consolas',
    fontSize: 10,
    letterSpacing: 1.2,
  },
  intro: {
    gap: 12,
    maxWidth: 560,
  },
  eyebrow: {
    color: '#FBA277',
    fontFamily: 'Consolas',
    fontSize: 12,
    letterSpacing: 2.2,
  },
  title: {
    color: '#F9EBD5',
    fontFamily: 'Georgia',
    fontSize: 48,
    fontWeight: '400',
    letterSpacing: -1.4,
    lineHeight: 55,
  },
  filmViewport: {
    backgroundColor: '#171619',
    borderBottomColor: '#453D40',
    borderBottomWidth: 1,
    borderTopColor: '#453D40',
    borderTopWidth: 1,
    marginHorizontal: -28,
    overflow: 'hidden',
    paddingVertical: 12,
  },
  filmTrack: {
    flexDirection: 'row',
    width: FILM_SET_WIDTH * 2,
  },
  filmCell: {
    gap: 8,
    marginRight: 12,
    width: 144,
  },
  perforationRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  perforation: {
    backgroundColor: '#51474A',
    borderRadius: 3,
    height: 5,
    width: 9,
  },
  filmFrame: {
    borderColor: '#51474A',
    borderWidth: 1,
    height: 176,
    overflow: 'hidden',
    position: 'relative',
  },
  frameGlowLarge: {
    borderRadius: 96,
    height: 192,
    left: -58,
    opacity: 0.32,
    position: 'absolute',
    top: 30,
    width: 192,
  },
  frameGlowSmall: {
    borderRadius: 48,
    borderWidth: 1,
    height: 96,
    opacity: 0.46,
    position: 'absolute',
    right: -24,
    top: -18,
    width: 96,
  },
});
