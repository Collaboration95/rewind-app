import { StyleSheet } from 'react-native';

import { ListGroup, ListRow, ScreenScroll, SubHeader, useToast } from '../../ui/primitives';
import type { SettingsGroup, SettingsScreenProps } from './types';

/* ---------- S7 Switch group ---------- */

export function SwitchGroup<T extends SettingsGroup>({
  onBack,
  groups,
  group,
  onSwitchGroup,
  switchPending,
  onJoin,
  onCreate,
}: SettingsScreenProps<T>) {
  const toast = useToast();
  return (
    <ScreenScroll>
      <SubHeader onBack={onBack} title="Switch group" />
      <ListGroup>
        {groups.map((item, index) => {
          const current = item.id === group?.group.id;
          return (
            <ListRow
              accessibilityState={{ selected: current }}
              disabled={switchPending}
              first={index === 0}
              icon="users"
              key={item.id}
              label={item.name}
              note={current ? 'Current group' : 'Tap to switch'}
              onPress={async () => {
                if (current) return;
                if (await onSwitchGroup(item.id)) {
                  toast(`Switched to ${item.name}.`);
                  onBack();
                }
              }}
              selected={current}
              testID={`real-settings-switch-${item.id}`}
            />
          );
        })}
      </ListGroup>
      <ListGroup style={styles.more}>
        <ListRow chevron first icon="key" label="Have an invite?" onPress={onJoin} />
        <ListRow chevron icon="plus" label="Create a group" onPress={onCreate} />
      </ListGroup>
    </ScreenScroll>
  );
}

const styles = StyleSheet.create({
  more: { marginTop: 10 },
});
