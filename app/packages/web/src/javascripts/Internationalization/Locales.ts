/**
 * Locale registry for the Standard Red Notes web client.
 *
 * Each supported language is described by its BCP-47 code, the name in English
 * (for debugging/menus) and, crucially, its NATIVE name as shown in the
 * language switcher. `dir` allows the document direction to be flipped for
 * right-to-left languages such as Arabic.
 *
 * To add a new language:
 *   1. Add an entry to `SUPPORTED_LOCALES` below.
 *   2. Create `Resources/<code>.ts` exporting a `LocaleResource`.
 *   3. Register it in `Resources/index.ts`.
 * The i18n config and the switcher pick it up automatically.
 */

export type LocaleDirection = 'ltr' | 'rtl'

export type LocaleDescriptor = {
  /** BCP-47 code, e.g. `pt-PT`. This is the i18next language key. */
  code: string
  /** English name, used in code/debugging. */
  englishName: string
  /** Native name shown to the user in the switcher. */
  nativeName: string
  /** Text direction. Defaults to `ltr`. */
  dir: LocaleDirection
}

export const DEFAULT_LOCALE = 'en'

export const SUPPORTED_LOCALES: LocaleDescriptor[] = [
  { code: 'en', englishName: 'English', nativeName: 'English', dir: 'ltr' },
  { code: 'pt-PT', englishName: 'Portuguese (Portugal)', nativeName: 'Português (Portugal)', dir: 'ltr' },
  { code: 'pt-BR', englishName: 'Portuguese (Brazil)', nativeName: 'Português (Brasil)', dir: 'ltr' },
  { code: 'es', englishName: 'Spanish', nativeName: 'Español', dir: 'ltr' },
  { code: 'fr', englishName: 'French', nativeName: 'Français', dir: 'ltr' },
  { code: 'de', englishName: 'German', nativeName: 'Deutsch', dir: 'ltr' },
  { code: 'it', englishName: 'Italian', nativeName: 'Italiano', dir: 'ltr' },
  { code: 'nl', englishName: 'Dutch', nativeName: 'Nederlands', dir: 'ltr' },
  { code: 'pl', englishName: 'Polish', nativeName: 'Polski', dir: 'ltr' },
  { code: 'ru', englishName: 'Russian', nativeName: 'Русский', dir: 'ltr' },
  { code: 'uk', englishName: 'Ukrainian', nativeName: 'Українська', dir: 'ltr' },
  { code: 'tr', englishName: 'Turkish', nativeName: 'Türkçe', dir: 'ltr' },
  { code: 'ja', englishName: 'Japanese', nativeName: '日本語', dir: 'ltr' },
  { code: 'ko', englishName: 'Korean', nativeName: '한국어', dir: 'ltr' },
  { code: 'zh-CN', englishName: 'Chinese (Simplified)', nativeName: '简体中文', dir: 'ltr' },
  { code: 'ar', englishName: 'Arabic', nativeName: 'العربية', dir: 'rtl' },
]

export const SUPPORTED_LOCALE_CODES = SUPPORTED_LOCALES.map((locale) => locale.code)

export const getLocaleDescriptor = (code: string | undefined): LocaleDescriptor => {
  if (!code) {
    return SUPPORTED_LOCALES[0]
  }
  const exact = SUPPORTED_LOCALES.find((locale) => locale.code === code)
  if (exact) {
    return exact
  }
  // Fall back on the primary subtag, e.g. `pt-AO` -> `pt-PT`, `de-AT` -> `de`.
  const primary = code.split('-')[0]
  const byPrimary = SUPPORTED_LOCALES.find((locale) => locale.code === primary || locale.code.startsWith(`${primary}-`))
  return byPrimary ?? SUPPORTED_LOCALES[0]
}

export const getLocaleDirection = (code: string | undefined): LocaleDirection => getLocaleDescriptor(code).dir
