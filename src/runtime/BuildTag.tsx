import { StyleSheet, Text } from 'react-native';

import { WARM } from '../ui/tokens';

export function BuildTag() {
  const sha = process.env.EXPO_PUBLIC_BUILD_SHA;
  const branch = process.env.EXPO_PUBLIC_BUILD_BRANCH;
  const label =
    sha && /^[a-f0-9]{40}$/.test(sha) ? `${branch ?? 'build'} · ${sha.slice(0, 7)}` : 'local';

  return (
    <Text style={styles.tag} testID="app-build-tag">
      Build · {label}
    </Text>
  );
}

const styles = StyleSheet.create({
  tag: { color: WARM.muted, fontSize: 12, marginBottom: 8 },
});
