import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { translate, type Language, type TranslationValues } from './translate';

export type { Language } from './translate';

export const LANGUAGE_STORAGE_KEY = '@rewind/language-v1';

interface LanguageContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (english: string, values?: TranslationValues) => string;
}

const englishOnly: LanguageContextValue = {
  language: 'en',
  setLanguage: () => undefined,
  t: (english, values) => translate('en', english, values),
};

const LanguageContext = createContext<LanguageContextValue>(englishOnly);

/**
 * Presentation language for the Demo. English remains the source copy; the
 * Chinese layer is a local display preference and never changes stored data.
 */
export function LanguageProvider({
  children,
  initialLanguage = 'en',
}: {
  children: ReactNode;
  initialLanguage?: Language;
}) {
  const [language, setLanguageState] = useState<Language>(initialLanguage);

  useEffect(() => {
    let mounted = true;
    void AsyncStorage.getItem(LANGUAGE_STORAGE_KEY)
      .then((stored) => {
        if (mounted && (stored === 'en' || stored === 'zh')) setLanguageState(stored);
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);

  const setLanguage = useCallback((next: Language) => {
    setLanguageState(next);
    void AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, next).catch(() => undefined);
  }, []);

  const value = useMemo<LanguageContextValue>(
    () => ({
      language,
      setLanguage,
      t: (english, values) => translate(language, english, values),
    }),
    [language, setLanguage],
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useI18n(): LanguageContextValue {
  return useContext(LanguageContext);
}
