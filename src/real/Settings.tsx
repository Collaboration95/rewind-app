import { StyleSheet, View } from 'react-native';

import { Glow } from '../ui/primitives';
import { WARM } from '../ui/tokens';
import { DeleteAccount } from './settings/DeleteAccount';
import { Invite } from './settings/Invite';
import { Members } from './settings/Members';
import { PromptScreen } from './settings/PromptScreen';
import { SettingsMain } from './settings/SettingsMain';
import { SwitchGroup } from './settings/SwitchGroup';
import { TimeZoneScreen } from './settings/TimeZoneScreen';
import type { SettingsGroup, SettingsScreenProps } from './settings/types';

export { PromptPicker } from './settings/PromptScreen';
export type { InviteControls, SettingsGroup, SettingsMember, SettingsStep } from './settings/types';

/* ---------- Settings ---------- */

export function SettingsScreen<T extends SettingsGroup>(props: SettingsScreenProps<T>) {
  const { step, onBack, group } = props;
  const back = step === 'main' ? onBack : () => props.onNavigate('main');
  return (
    <View style={styles.screen} testID={`real-settings-${step}`}>
      <Glow />
      {step === 'main' ? <SettingsMain {...props} onBack={back} /> : null}
      {step === 'members' && group ? <Members {...props} group={group} onBack={back} /> : null}
      {step === 'groups' ? <SwitchGroup {...props} onBack={back} /> : null}
      {step === 'invite' && group ? <Invite {...props} group={group} onBack={back} /> : null}
      {step === 'prompt' && group ? <PromptScreen {...props} group={group} onBack={back} /> : null}
      {step === 'tz' && group ? <TimeZoneScreen {...props} group={group} onBack={back} /> : null}
      {step === 'delete' ? <DeleteAccount {...props} onBack={back} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: WARM.bg, flex: 1, overflow: 'hidden' },
});
