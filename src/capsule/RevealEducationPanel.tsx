import {
  getRevealEducationCopy,
  type RevealEducationState,
  type RevealEducationSurface,
} from '../domain/reveal-education';
import { useI18n } from '../i18n/LanguageProvider';
import { ActionButton, SealCard } from '../ui/kit';

/** Concept A seal card: film status in words, then one honest next action. */
export function RevealEducationPanel({
  actionLabel,
  onAction,
  state,
  surface,
  testID,
}: {
  actionLabel?: string;
  onAction?: () => void | Promise<void>;
  state: RevealEducationState;
  surface: RevealEducationSurface;
  testID: string;
}) {
  const { t } = useI18n();
  const copy = getRevealEducationCopy(surface, state);
  const label = t(actionLabel ?? copy.actionLabel);
  return (
    <SealCard
      action={
        onAction ? (
          <ActionButton
            accessibilityHint={t('Next action: {label}', { label })}
            full
            label={label}
            onPress={onAction}
            variant={state === 'released' ? 'primary' : 'secondary'}
          />
        ) : null
      }
      body={t(copy.body)}
      label={t(state === 'released' ? 'RELEASED' : 'REVEAL STATUS')}
      testID={testID}
      title={t(copy.title)}
    />
  );
}
