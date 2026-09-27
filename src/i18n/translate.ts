import { APP_ZH } from './app-zh';
import { DESIGN_STUDY_ZH } from './design-study-zh';

export type Language = 'en' | 'zh';
export type TranslationValues = Record<string, string | number>;

const ZH: Record<string, string> = { ...DESIGN_STUDY_ZH, ...APP_ZH };

function interpolate(template: string, values?: TranslationValues): string {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : match,
  );
}

/** English is the source text; a missing Chinese entry falls back to English. */
export function translate(language: Language, english: string, values?: TranslationValues) {
  const template = language === 'zh' ? (ZH[english] ?? english) : english;
  return interpolate(template, values);
}

export function hasTranslation(english: string): boolean {
  return Object.hasOwn(ZH, english);
}
