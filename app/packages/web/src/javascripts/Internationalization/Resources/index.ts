import type { Resource } from 'i18next'
import en, { type LocaleResource } from './en'
import ptPT from './pt-PT'
import ptBR from './pt-BR'
import es from './es'
import fr from './fr'
import de from './de'
import it from './it'
import nl from './nl'
import pl from './pl'
import ru from './ru'
import uk from './uk'
import tr from './tr'
import ja from './ja'
import ko from './ko'
import zhCN from './zh-CN'
import ar from './ar'

export type { LocaleResource }

/**
 * The namespaces exposed by the app. `common` is the default namespace. The
 * first four are fully translated in every locale; the surface namespaces that
 * follow are filled incrementally and fall back to English when a locale has
 * not translated them yet.
 */
export const NAMESPACES = [
  'common',
  'navigation',
  'account',
  'preferences',
  'editor',
  'notes',
  'files',
  'search',
  'dialogs',
  'auth',
  'sharing',
  'settings',
  'errors',
  'onboarding',
] as const
export const DEFAULT_NAMESPACE = 'common'

/**
 * All locales keyed by BCP-47 code. Each locale is a `LocaleResource`, so the
 * objects are structurally identical to the English base, which keeps the
 * translation surface honest and lets `tsc` catch missing/misspelled keys.
 */
export const LOCALE_RESOURCES: Record<string, LocaleResource> = {
  en,
  'pt-PT': ptPT,
  'pt-BR': ptBR,
  es,
  fr,
  de,
  it,
  nl,
  pl,
  ru,
  uk,
  tr,
  ja,
  ko,
  'zh-CN': zhCN,
  ar,
}

/**
 * Builds the i18next-shaped resource tree, splitting each flat locale object
 * into the declared namespaces:
 *   { en: { common: {...}, navigation: {...}, ... }, 'pt-PT': { ... } }
 */
export const buildI18nResources = (): Resource => {
  const resources: Resource = {}
  for (const [code, resource] of Object.entries(LOCALE_RESOURCES)) {
    resources[code] = {}
    for (const namespace of NAMESPACES) {
      // Surface namespaces are optional per locale; only register the ones a
      // locale actually provides so i18next falls back to English for the rest.
      const value = (resource as Record<string, unknown>)[namespace]
      if (value !== undefined) {
        resources[code][namespace] = value as Resource[string][string]
      }
    }
  }
  return resources
}
