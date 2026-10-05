import { useEffect } from 'react';
import { Platform } from 'react-native';
import { useFonts } from 'expo-font';

import { FONT } from './tokens';

const FONTS = {
  [FONT.serif]: require('../../assets/fonts/Fraunces.ttf'),
  [FONT.body]: require('../../assets/fonts/Geist.ttf'),
  [FONT.mono]: require('../../assets/fonts/DMMono-Regular.ttf'),
  [FONT.monoMedium]: require('../../assets/fonts/DMMono-Medium.ttf'),
};

// expo-font declares each web @font-face without a weight range, so the
// browser would fake bold instead of using the variable fonts' weight axis.
// Repeat the variable faces with their full range.
function addWeightRanges() {
  if (typeof document === 'undefined') return;
  const variable = new Set<string>([FONT.serif, FONT.body]);
  const extra: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSFontFaceRule)) continue;
      const family = rule.style.getPropertyValue('font-family').replace(/["']/g, '').trim();
      const src = rule.style.getPropertyValue('src');
      if (
        variable.has(family) &&
        src &&
        !rule.style.getPropertyValue('font-weight').includes(' ')
      ) {
        extra.push(
          `@font-face{font-family:"${family}";src:${src};font-weight:100 900;font-display:swap}`,
        );
        variable.delete(family);
      }
    }
  }
  if (!extra.length) return;
  const style = document.createElement('style');
  style.id = 'rewind-font-weights';
  style.textContent = extra.join('\n');
  document.head.appendChild(style);
}

/** Load Fraunces, Geist and DM Mono. Returns true once text can be drawn in them. */
export function useWarmFonts(): boolean {
  const [loaded, error] = useFonts(FONTS);
  useEffect(() => {
    if (loaded && Platform.OS === 'web') addWeightRanges();
  }, [loaded]);
  // The web falls back to system fonts until the files arrive; native must
  // wait, because an unknown font family is an error there.
  return loaded || Boolean(error) || Platform.OS === 'web' || process.env.NODE_ENV === 'test';
}
