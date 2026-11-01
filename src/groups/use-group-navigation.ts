import { useCallback, useState } from 'react';

import type { SettingsStep } from '../real/Settings';
import type { ShellTab } from '../real/Shell';

export type Push =
  | { kind: 'settings'; step: SettingsStep }
  | { kind: 'mine' }
  | { kind: 'capture' }
  | { kind: 'join' }
  | { kind: 'create' }
  | { kind: 'film'; cycleId: string; label: string };

/** The tab, the pushed-screen stack and the group menu. */
export function useGroupNavigation() {
  const [tab, setTab] = useState<ShellTab>('home');
  const [stack, setStack] = useState<Push[]>([]);
  const top = stack[stack.length - 1] ?? null;
  const pushScreen = useCallback((next: Push) => setStack((current) => [...current, next]), []);
  const popScreen = useCallback(() => setStack((current) => current.slice(0, -1)), []);
  const replaceScreen = (next: Push) => setStack((current) => [...current.slice(0, -1), next]);
  const [menuOpen, setMenuOpen] = useState(false);
  const goHome = useCallback(() => {
    setStack([]);
    setTab('home');
    setMenuOpen(false);
  }, []);
  return {
    tab,
    setTab,
    stack,
    setStack,
    top,
    pushScreen,
    popScreen,
    replaceScreen,
    menuOpen,
    setMenuOpen,
    goHome,
  };
}
