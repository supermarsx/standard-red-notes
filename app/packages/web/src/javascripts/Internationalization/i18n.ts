import i18n, { type i18n as I18nInstance } from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { buildI18nResources, DEFAULT_NAMESPACE, NAMESPACES } from './Resources'
import { DEFAULT_LOCALE, getLocaleDescriptor, SUPPORTED_LOCALE_CODES } from './Locales'

/**
 * localStorage key under which the user's chosen language is persisted. The
 * browser language detector reads/writes this so the choice survives reloads,
 * and `applyDocumentLanguage` mirrors it onto the <html> element.
 */
export const LANGUAGE_STORAGE_KEY = 'sn-language'

let initialized = false

/**
 * Reflects the active language onto the document: sets <html lang> and, for
 * RTL languages (e.g. Arabic), <html dir="rtl">. This is the document-level
 * RTL handling for `ar`.
 */
export const applyDocumentLanguage = (language: string): void => {
  if (typeof document === 'undefined') {
    return
  }
  const descriptor = getLocaleDescriptor(language)
  document.documentElement.lang = descriptor.code
  document.documentElement.dir = descriptor.dir
}

/**
 * Initializes i18next exactly once at app bootstrap.
 *  - English (`en`) is the fallback for any missing key.
 *  - Language is detected from localStorage first, then the browser, on first run.
 *  - Interpolation, pluralization and namespaces are all enabled by i18next.
 */
export const initializeI18n = (): I18nInstance => {
  if (initialized) {
    return i18n
  }
  initialized = true

  i18n
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      resources: buildI18nResources(),
      supportedLngs: SUPPORTED_LOCALE_CODES,
      fallbackLng: DEFAULT_LOCALE,
      ns: NAMESPACES as unknown as string[],
      defaultNS: DEFAULT_NAMESPACE,
      load: 'currentOnly',
      nonExplicitSupportedLngs: true,
      interpolation: {
        // React already escapes values, so i18next must not double-escape.
        escapeValue: false,
      },
      detection: {
        order: ['localStorage', 'navigator'],
        lookupLocalStorage: LANGUAGE_STORAGE_KEY,
        caches: ['localStorage'],
      },
      returnNull: false,
    })
    .catch((error) => {
      // i18n must never crash the app; English keys remain available regardless.
      console.error('Failed to initialize i18n', error)
    })

  applyDocumentLanguage(i18n.language || DEFAULT_LOCALE)

  i18n.on('languageChanged', (language) => {
    applyDocumentLanguage(language)
  })

  return i18n
}

/** Switches the active language, persists it, and updates the document. */
export const changeLanguage = async (language: string): Promise<void> => {
  await i18n.changeLanguage(language)
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language)
  } catch {
    // localStorage may be unavailable (private mode); the change still applies
    // for the current session.
  }
  applyDocumentLanguage(language)
}

export default i18n
