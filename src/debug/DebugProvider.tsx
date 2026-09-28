import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { isDebugScreen, isScenarioFor, type DebugRuntimeMode, type DebugScreen } from './scenarios';
import { DEBUG_BUILD_ENABLED } from './build-mode';

export const DEBUG_STORAGE_KEY = '@rewind/debug-state-v1';

type ScenarioMap = Partial<Record<DebugScreen, string>>;

interface DebugState {
  enabled: boolean;
  runtime: DebugRuntimeMode;
  scenarios: ScenarioMap;
}

interface DebugContextValue extends DebugState {
  setEnabled: (enabled: boolean) => void;
  setRuntime: (runtime: DebugRuntimeMode) => void;
  setScenario: (screen: DebugScreen, scenario: string) => void;
  /** Steps through scenarios on a timer, like the study's sample upload. */
  playScenarios: (screen: DebugScreen, steps: string[], intervalMs?: number) => void;
  clearScenarios: () => void;
  sheetOpen: boolean;
  setSheetOpen: (open: boolean) => void;
  sheetScreen: DebugScreen | null;
  openSheet: (screen: DebugScreen) => void;
}

const inactive: DebugContextValue = {
  enabled: false,
  runtime: 'live',
  scenarios: {},
  setEnabled: () => undefined,
  setRuntime: () => undefined,
  setScenario: () => undefined,
  playScenarios: () => undefined,
  clearScenarios: () => undefined,
  sheetOpen: false,
  setSheetOpen: () => undefined,
  sheetScreen: null,
  openSheet: () => undefined,
};

const DebugContext = createContext<DebugContextValue>(inactive);

function parseStored(raw: string | null): DebugState | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<DebugState>;
    const scenarios: ScenarioMap = {};
    if (value.scenarios && typeof value.scenarios === 'object') {
      for (const [screen, scenario] of Object.entries(value.scenarios)) {
        if (
          isDebugScreen(screen) &&
          typeof scenario === 'string' &&
          isScenarioFor(screen, scenario)
        )
          scenarios[screen] = scenario;
      }
    }
    return {
      enabled: value.enabled === true,
      runtime: value.runtime === 'offline' ? 'offline' : 'live',
      scenarios,
    };
  } catch {
    return null;
  }
}

/**
 * Settings-owned developer mode. When enabled, each screen may be forced into
 * one of the study's states so reviewers can inspect copy on a real device.
 * Disabling it returns every screen to live data immediately.
 */
export function DebugProvider({
  children,
  initialState,
}: {
  children: ReactNode;
  initialState?: Partial<DebugState>;
}) {
  const [state, setState] = useState<DebugState>(() =>
    DEBUG_BUILD_ENABLED
      ? {
          enabled: initialState?.enabled ?? false,
          runtime: initialState?.runtime ?? 'live',
          scenarios: initialState?.scenarios ?? {},
        }
      : { enabled: false, runtime: 'live', scenarios: {} },
  );
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetScreen, setSheetScreen] = useState<DebugScreen | null>(null);
  const hydrated = useRef(Boolean(initialState) || !DEBUG_BUILD_ENABLED);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearTimers = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }, []);

  useEffect(() => {
    if (!DEBUG_BUILD_ENABLED) {
      void AsyncStorage.removeItem(DEBUG_STORAGE_KEY).catch(() => undefined);
      return;
    }
    if (hydrated.current) return;
    let mounted = true;
    void AsyncStorage.getItem(DEBUG_STORAGE_KEY)
      .then((raw) => {
        const stored = parseStored(raw);
        if (mounted && stored) setState(stored);
      })
      .catch(() => undefined)
      .finally(() => {
        hydrated.current = true;
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const update = useCallback((recipe: (current: DebugState) => DebugState) => {
    if (!DEBUG_BUILD_ENABLED) return;
    setState((current) => {
      const next = recipe(current);
      void AsyncStorage.setItem(DEBUG_STORAGE_KEY, JSON.stringify(next)).catch(() => undefined);
      return next;
    });
  }, []);

  const setEnabled = useCallback(
    (enabled: boolean) => {
      clearTimers();
      if (!enabled) setSheetOpen(false);
      update((current) => ({ ...current, enabled }));
    },
    [clearTimers, update],
  );

  const setRuntime = useCallback(
    (runtime: DebugRuntimeMode) => update((current) => ({ ...current, runtime })),
    [update],
  );

  const setScenario = useCallback(
    (screen: DebugScreen, scenario: string) => {
      clearTimers();
      update((current) => ({
        ...current,
        scenarios: { ...current.scenarios, [screen]: scenario },
      }));
    },
    [clearTimers, update],
  );

  const playScenarios = useCallback(
    (screen: DebugScreen, steps: string[], intervalMs = 900) => {
      clearTimers();
      steps.forEach((step, index) => {
        const apply = () =>
          update((current) => ({
            ...current,
            scenarios: { ...current.scenarios, [screen]: step },
          }));
        if (index === 0) apply();
        else timers.current.push(setTimeout(apply, intervalMs * index));
      });
    },
    [clearTimers, update],
  );

  const clearScenarios = useCallback(() => {
    clearTimers();
    update((current) => ({ ...current, runtime: 'live', scenarios: {} }));
  }, [clearTimers, update]);

  const openSheet = useCallback((screen: DebugScreen) => {
    setSheetScreen(screen);
    setSheetOpen(true);
  }, []);

  const value = useMemo<DebugContextValue>(
    () => ({
      ...state,
      setEnabled,
      setRuntime,
      setScenario,
      playScenarios,
      clearScenarios,
      sheetOpen,
      setSheetOpen,
      sheetScreen,
      openSheet,
    }),
    [
      clearScenarios,
      openSheet,
      playScenarios,
      setEnabled,
      setRuntime,
      setScenario,
      sheetOpen,
      sheetScreen,
      state,
    ],
  );

  return <DebugContext.Provider value={value}>{children}</DebugContext.Provider>;
}

export function useDebug(): DebugContextValue {
  return useContext(DebugContext);
}

export interface ScreenDebug<S extends string = string> {
  /** The forced state, or null when debug mode is off or the screen is live. */
  scenario: S | null;
  set: (scenario: S | 'live') => void;
  play: (steps: (S | 'live')[], intervalMs?: number) => void;
}

export function useDebugScenario<S extends string = string>(screen: DebugScreen): ScreenDebug<S> {
  const { enabled, scenarios, setScenario, playScenarios } = useDebug();
  const forced = enabled ? scenarios[screen] : undefined;
  return useMemo(
    () => ({
      scenario: forced && forced !== 'live' ? (forced as S) : null,
      set: (scenario) => setScenario(screen, scenario),
      play: (steps, intervalMs) => playScenarios(screen, steps, intervalMs),
    }),
    [forced, playScenarios, screen, setScenario],
  );
}

/** True when debug mode simulates a missing local runtime. */
export function useDebugOfflineRuntime(): boolean {
  const { enabled, runtime } = useDebug();
  return enabled && runtime === 'offline';
}
