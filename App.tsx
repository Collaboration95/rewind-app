import { useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { Image, ImageSourcePropType, Pressable, StyleSheet, Text, View } from 'react-native';

const COLORS = {
  accent: '#FFA572',
  background: '#252326',
  celluloid: '#24170F',
  deep: '#1D1B1E',
  edge: '#BBA270',
  ink: '#F9EBD5',
  line: '#51474A',
  muted: '#B9ABA0',
  paper: '#302D30',
};

const ROUTES = [
  { icon: '⌂', key: 'home', label: 'Home' },
  { icon: '◎', key: 'camera', label: 'Camera' },
  { icon: '○', key: 'chat', label: 'Chat' },
  { icon: '▣', key: 'archive', label: 'Archive' },
] as const;

const FILM_FRAMES: readonly {
  bottomLabel: string;
  label: string;
  position: 'center' | 'left' | 'right';
  source: ImageSourcePropType;
}[] = [
  {
    bottomLabel: '01A',
    label: '01 · SEALED',
    position: 'center',
    source: require('./assets/demo/rewind-blurred-memory.webp'),
  },
  {
    bottomLabel: '02A',
    label: '02 · SEALED',
    position: 'right',
    source: require('./assets/demo/rewind-friends.webp'),
  },
  {
    bottomLabel: '03A',
    label: '+6 MOMENTS',
    position: 'left',
    source: require('./assets/demo/rewind-snow.webp'),
  },
];

const MEMBERS = ['A', 'B', 'C', 'E', 'D'];
const SPROCKETS = Array.from({ length: 13 }, (_, index) => index);

type RouteKey = (typeof ROUTES)[number]['key'];

function AppHeader() {
  return (
    <View style={styles.header}>
      <View accessibilityLabel="Rewind" accessible style={styles.brandRow}>
        <Text style={styles.brandIcon}>‹‹</Text>
        <Text style={styles.brand}>rewind</Text>
      </View>
      <View style={styles.userRow}>
        <Text style={styles.userName}>Alex</Text>
        <View accessibilityLabel="Alex demo profile" style={styles.profileAvatar}>
          <Text style={styles.profileAvatarText}>A</Text>
        </View>
      </View>
    </View>
  );
}

function LockMark() {
  return (
    <View accessibilityElementsHidden style={styles.lockBadge}>
      <View style={styles.lockShackle} />
      <View style={styles.lockBody} />
    </View>
  );
}

function SprocketRow() {
  return (
    <View accessibilityElementsHidden style={styles.sprocketRow}>
      {SPROCKETS.map((index) => (
        <View key={index} style={styles.sprocket} />
      ))}
    </View>
  );
}

function FilmStrip() {
  return (
    <View
      accessibilityLabel="Three locked demo moments on a 35 millimeter film strip"
      style={styles.filmStage}
      testID="sealed-film-strip"
    >
      <View style={styles.filmShadow} />
      <View style={styles.filmStrip}>
        <SprocketRow />
        <View style={styles.filmEdgeTop}>
          <Text style={styles.filmEdgeText}>REWIND 400</Text>
          <Text style={styles.filmEdgeText}>36 EXP ▸</Text>
        </View>
        <View style={styles.filmFrames}>
          {FILM_FRAMES.map(({ bottomLabel, label, position, source }) => (
            <View key={bottomLabel} style={styles.filmFrame}>
              <Image
                blurRadius={4}
                resizeMode="cover"
                source={source}
                style={[
                  styles.filmImage,
                  position === 'left' && styles.filmImageLeft,
                  position === 'right' && styles.filmImageRight,
                ]}
              />
              <View style={styles.filmVeil} />
              <LockMark />
              <Text style={styles.frameLabel}>{label}</Text>
            </View>
          ))}
        </View>
        <View style={styles.filmEdgeBottom}>
          {FILM_FRAMES.map(({ bottomLabel }) => (
            <Text key={bottomLabel} style={styles.filmEdgeText}>
              {bottomLabel}
            </Text>
          ))}
        </View>
        <SprocketRow />
      </View>
    </View>
  );
}

function Prompt() {
  return (
    <View style={styles.prompt}>
      <Text style={styles.sectionLabel}>THIS WEEK’S PROMPT</Text>
      <Text style={styles.promptText}>What made you pause{`\n`}and smile?</Text>
    </View>
  );
}

function MemberProgress() {
  return (
    <View style={styles.memberRow}>
      <View
        accessibilityLabel="Alex, Bea, Chen, and Emi contributed; Dev is waiting"
        style={styles.members}
      >
        {MEMBERS.map((member, index) => (
          <View
            key={member}
            style={[styles.memberAvatar, index === MEMBERS.length - 1 && styles.waitingAvatar]}
          >
            <Text style={[styles.memberText, index === MEMBERS.length - 1 && styles.waitingText]}>
              {member}
            </Text>
          </View>
        ))}
      </View>
      <Text style={styles.memberCopy}>4 of 5 friends added moments</Text>
    </View>
  );
}

function WeeklyQuota() {
  return (
    <View style={styles.quota}>
      <View style={styles.quotaCopy}>
        <Text style={styles.quotaLabel}>Your week</Text>
        <Text style={styles.quotaValue}>2 / 5 photos · 08 / 30 sec</Text>
      </View>
      <View accessibilityLabel="2 of 5 photos used" style={styles.progressTrack}>
        {[0, 1, 2, 3, 4].map((index) => (
          <View
            key={index}
            style={[styles.progressSegment, index < 2 && styles.progressSegmentActive]}
          />
        ))}
      </View>
    </View>
  );
}

function HomeScreen({ onAdd }: { onAdd: () => void }) {
  return (
    <View style={styles.screen}>
      <AppHeader />
      <View style={styles.homeContent}>
        <View style={styles.groupRow}>
          <Text accessibilityRole="header" style={styles.groupName}>
            Weekend People
          </Text>
          <View style={styles.rollBadge}>
            <Text style={styles.rollBadgeText}>ROLL 036</Text>
          </View>
        </View>
        <Text accessibilityLabel="Developing local demo" style={styles.statusLine}>
          DEVELOPING · LOCAL DEMO
        </Text>
        <View accessibilityLabel="Reveal in 2 days 14 hours" style={styles.clock}>
          <View style={styles.clockUnit}>
            <Text style={styles.clockNumber}>02</Text>
            <Text style={styles.clockLabel}>DAYS</Text>
          </View>
          <Text style={styles.clockDivider}>:</Text>
          <View style={styles.clockUnit}>
            <Text style={styles.clockNumber}>14</Text>
            <Text style={styles.clockLabel}>HOURS</Text>
          </View>
        </View>
        <Text style={styles.revealDate}>Lights on Sunday · 8:00 PM</Text>
        <FilmStrip />
        <Prompt />
        <MemberProgress />
        <WeeklyQuota />
        <Pressable
          accessibilityLabel="Add to the roll"
          accessibilityRole="button"
          onPress={onAdd}
          style={styles.primaryButton}
        >
          <Text accessibilityElementsHidden style={styles.cameraGlyph}>
            ◎
          </Text>
          <Text style={styles.primaryButtonText}>Add to the roll</Text>
        </Pressable>
      </View>
    </View>
  );
}

function RouteScreen({ label }: { label: string }) {
  return (
    <View style={styles.screen}>
      <AppHeader />
      <View style={styles.routeContent}>
        <Text style={styles.sectionLabel}>LOCAL DEMO</Text>
        <Text accessibilityRole="header" style={styles.routeTitle}>
          {label}
        </Text>
      </View>
    </View>
  );
}

function BottomNavigation({
  activeRoute,
  onSelect,
}: {
  activeRoute: RouteKey;
  onSelect: (route: RouteKey) => void;
}) {
  return (
    <View accessibilityLabel="Main navigation" accessibilityRole="tablist" style={styles.navBar}>
      {ROUTES.map(({ icon, key, label }) => {
        const isActive = activeRoute === key;

        return (
          <Pressable
            accessibilityLabel={label}
            accessibilityRole="tab"
            accessibilityState={{ selected: isActive }}
            aria-selected={isActive}
            key={key}
            onPress={() => onSelect(key)}
            style={styles.navItem}
          >
            <Text
              accessibilityElementsHidden
              importantForAccessibility="no"
              style={[styles.navIcon, isActive && styles.navActive]}
            >
              {icon}
            </Text>
            <Text style={[styles.navLabel, isActive && styles.navActive]}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export default function App() {
  const [activeRoute, setActiveRoute] = useState<RouteKey>('home');
  const activeItem = ROUTES.find(({ key }) => key === activeRoute) ?? ROUTES[0];

  return (
    <View style={styles.appBackground}>
      <View style={styles.appFrame}>
        <StatusBar style="light" />
        {activeRoute === 'home' ? (
          <HomeScreen onAdd={() => setActiveRoute('camera')} />
        ) : (
          <RouteScreen label={activeItem.label} />
        )}
        <BottomNavigation activeRoute={activeRoute} onSelect={setActiveRoute} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  appBackground: {
    alignItems: 'center',
    backgroundColor: COLORS.deep,
    flex: 1,
  },
  appFrame: {
    backgroundColor: COLORS.background,
    flex: 1,
    maxWidth: 390,
    width: '100%',
  },
  screen: {
    flex: 1,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    height: 84,
    justifyContent: 'space-between',
    paddingHorizontal: 21,
    paddingTop: 26,
  },
  brandRow: {
    alignItems: 'center',
    flexDirection: 'row',
  },
  brandIcon: {
    color: COLORS.ink,
    fontFamily: 'Georgia',
    fontSize: 21,
    letterSpacing: -5,
    marginRight: 7,
    marginTop: -2,
  },
  brand: {
    color: COLORS.ink,
    fontFamily: 'Consolas',
    fontSize: 19,
    fontWeight: '700',
    letterSpacing: -1,
  },
  userRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 9,
  },
  userName: {
    color: COLORS.muted,
    fontFamily: 'Consolas',
    fontSize: 12,
  },
  profileAvatar: {
    alignItems: 'center',
    backgroundColor: COLORS.accent,
    borderRadius: 18,
    height: 34,
    justifyContent: 'center',
    width: 34,
  },
  profileAvatarText: {
    color: COLORS.deep,
    fontFamily: 'Consolas',
    fontSize: 13,
    fontWeight: '700',
  },
  homeContent: {
    flex: 1,
    justifyContent: 'space-between',
    paddingBottom: 11,
    paddingHorizontal: 21,
  },
  groupRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  groupName: {
    color: COLORS.ink,
    fontFamily: 'Georgia',
    fontSize: 23,
    fontWeight: '600',
    letterSpacing: -0.4,
  },
  rollBadge: {
    borderColor: COLORS.line,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  rollBadgeText: {
    color: COLORS.muted,
    fontFamily: 'Consolas',
    fontSize: 10,
    letterSpacing: 0.7,
  },
  statusLine: {
    color: COLORS.accent,
    fontFamily: 'Consolas',
    fontSize: 11,
    letterSpacing: 1.2,
    marginBottom: 1,
    marginTop: 10,
  },
  clock: {
    alignItems: 'center',
    flexDirection: 'row',
    height: 74,
  },
  clockUnit: {
    alignItems: 'center',
    flexDirection: 'row',
  },
  clockNumber: {
    color: COLORS.ink,
    fontFamily: 'Georgia',
    fontSize: 56,
    fontWeight: '400',
    letterSpacing: -2,
    lineHeight: 64,
  },
  clockLabel: {
    color: COLORS.muted,
    fontFamily: 'Consolas',
    fontSize: 9,
    letterSpacing: 1.4,
    marginLeft: 6,
    marginTop: 33,
  },
  clockDivider: {
    color: COLORS.ink,
    fontFamily: 'Georgia',
    fontSize: 38,
    marginHorizontal: 11,
    marginTop: -7,
  },
  revealDate: {
    color: COLORS.muted,
    fontFamily: 'Consolas',
    fontSize: 11,
    marginBottom: 2,
    marginTop: -3,
  },
  filmStage: {
    height: 223,
    marginHorizontal: -21,
    overflow: 'hidden',
    position: 'relative',
  },
  filmShadow: {
    backgroundColor: 'rgba(0, 0, 0, 0.34)',
    height: 170,
    left: -18,
    position: 'absolute',
    right: -18,
    top: 25,
    transform: [{ rotate: '-2.8deg' }],
  },
  filmStrip: {
    backgroundColor: COLORS.celluloid,
    borderColor: '#806F4E',
    borderRadius: 2,
    borderWidth: 1,
    left: -23,
    paddingHorizontal: 8,
    paddingVertical: 6,
    position: 'absolute',
    right: -23,
    top: 15,
    transform: [{ perspective: 700 }, { rotateY: '-5deg' }, { rotate: '-2.8deg' }],
  },
  sprocketRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 2,
  },
  sprocket: {
    backgroundColor: COLORS.background,
    borderRadius: 2,
    flex: 1,
    height: 8,
  },
  filmEdgeTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingBottom: 3,
    paddingHorizontal: 25,
    paddingTop: 4,
  },
  filmEdgeText: {
    color: COLORS.edge,
    fontFamily: 'Consolas',
    fontSize: 10,
    letterSpacing: 0.3,
  },
  filmFrames: {
    flexDirection: 'row',
    gap: 5,
  },
  filmFrame: {
    backgroundColor: COLORS.deep,
    borderColor: '#5A4B31',
    borderRadius: 2,
    borderWidth: 1,
    flex: 1,
    height: 113,
    overflow: 'hidden',
    position: 'relative',
  },
  filmImage: {
    height: '112%',
    left: '-6%',
    position: 'absolute',
    top: '-6%',
    width: '112%',
  },
  filmImageLeft: {
    left: '-12%',
  },
  filmImageRight: {
    left: '0%',
  },
  filmVeil: {
    backgroundColor: 'rgba(29, 27, 30, 0.44)',
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
  lockBadge: {
    alignItems: 'center',
    backgroundColor: 'rgba(29, 27, 30, 0.56)',
    borderRadius: 14,
    height: 28,
    justifyContent: 'center',
    left: '50%',
    marginLeft: -14,
    marginTop: -18,
    position: 'absolute',
    top: '50%',
    width: 28,
  },
  lockShackle: {
    borderColor: COLORS.ink,
    borderTopLeftRadius: 5,
    borderTopRightRadius: 5,
    borderTopWidth: 1.5,
    borderWidth: 1.5,
    height: 7,
    marginBottom: -1,
    width: 8,
  },
  lockBody: {
    backgroundColor: COLORS.ink,
    borderRadius: 1,
    height: 7,
    width: 10,
  },
  frameLabel: {
    bottom: 7,
    color: COLORS.ink,
    fontFamily: 'Consolas',
    fontSize: 9,
    left: 0,
    position: 'absolute',
    right: 0,
    textAlign: 'center',
  },
  filmEdgeBottom: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingBottom: 4,
    paddingTop: 3,
  },
  prompt: {
    marginBottom: 9,
    marginTop: -1,
  },
  sectionLabel: {
    color: COLORS.accent,
    fontFamily: 'Consolas',
    fontSize: 10,
    letterSpacing: 1.6,
  },
  promptText: {
    color: COLORS.ink,
    fontFamily: 'Georgia',
    fontSize: 23,
    letterSpacing: -0.4,
    lineHeight: 26,
    marginTop: 6,
  },
  memberRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  members: {
    flexDirection: 'row',
    paddingLeft: 1,
  },
  memberAvatar: {
    alignItems: 'center',
    backgroundColor: '#4B3830',
    borderColor: COLORS.background,
    borderRadius: 16,
    borderWidth: 2,
    height: 31,
    justifyContent: 'center',
    marginLeft: -5,
    width: 31,
  },
  waitingAvatar: {
    backgroundColor: COLORS.background,
    borderColor: COLORS.line,
    borderStyle: 'dashed',
  },
  memberText: {
    color: COLORS.ink,
    fontFamily: 'Consolas',
    fontSize: 10,
    fontWeight: '700',
  },
  waitingText: {
    color: COLORS.muted,
  },
  memberCopy: {
    color: COLORS.muted,
    fontFamily: 'Consolas',
    fontSize: 10,
    lineHeight: 14,
    maxWidth: 132,
    textAlign: 'right',
  },
  quota: {
    marginBottom: 11,
    marginTop: 11,
  },
  quotaCopy: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 7,
  },
  quotaLabel: {
    color: COLORS.muted,
    fontFamily: 'Consolas',
    fontSize: 10,
  },
  quotaValue: {
    color: COLORS.muted,
    fontFamily: 'Consolas',
    fontSize: 10,
  },
  progressTrack: {
    flexDirection: 'row',
    gap: 5,
  },
  progressSegment: {
    backgroundColor: COLORS.line,
    borderRadius: 3,
    flex: 1,
    height: 4,
  },
  progressSegmentActive: {
    backgroundColor: COLORS.accent,
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: COLORS.accent,
    borderRadius: 999,
    flexDirection: 'row',
    height: 46,
    justifyContent: 'center',
  },
  cameraGlyph: {
    color: '#2C211D',
    fontFamily: 'Consolas',
    fontSize: 18,
    marginRight: 9,
  },
  primaryButtonText: {
    color: '#2C211D',
    fontFamily: 'Consolas',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  routeContent: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  routeTitle: {
    color: COLORS.ink,
    fontFamily: 'Georgia',
    fontSize: 44,
    marginTop: 10,
  },
  navBar: {
    backgroundColor: COLORS.paper,
    borderColor: COLORS.line,
    borderTopWidth: 1,
    flexDirection: 'row',
    height: 72,
    paddingHorizontal: 7,
  },
  navItem: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
  },
  navIcon: {
    color: COLORS.muted,
    fontFamily: 'Consolas',
    fontSize: 21,
    height: 25,
  },
  navLabel: {
    color: COLORS.muted,
    fontFamily: 'Consolas',
    fontSize: 10,
    marginTop: 3,
  },
  navActive: {
    color: COLORS.accent,
    fontWeight: '700',
  },
});
