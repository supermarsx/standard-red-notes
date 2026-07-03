/**
 * Tests for the i18n foundation: fallback to English, real translations in
 * pt-PT and other locales, and that every supported locale exposes the full
 * core namespace surface.
 */
import i18next from 'i18next'
import { buildI18nResources, LOCALE_RESOURCES, NAMESPACES } from './Resources'
import en from './Resources/en'
import { SUPPORTED_LOCALES, getLocaleDescriptor, getLocaleDirection } from './Locales'

const createInstance = async () => {
  const instance = i18next.createInstance()
  await instance.init({
    resources: buildI18nResources(),
    fallbackLng: 'en',
    ns: NAMESPACES as unknown as string[],
    defaultNS: 'common',
    lng: 'en',
    interpolation: { escapeValue: false },
    returnNull: false,
  })
  return instance
}

describe('i18n foundation', () => {
  it('registers exactly 16 supported locales including en and pt-PT', () => {
    expect(SUPPORTED_LOCALES).toHaveLength(16)
    const codes = SUPPORTED_LOCALES.map((l) => l.code)
    expect(codes).toContain('en')
    expect(codes).toContain('pt-PT')
  })

  // The four original namespaces are fully translated in every locale and must
  // stay that way: exact key parity with English, no missing/extra keys.
  const CORE_NAMESPACES = ['common', 'navigation', 'account', 'preferences'] as const

  it('keeps exact parity for the core namespaces in every locale', () => {
    for (const { code } of SUPPORTED_LOCALES) {
      const resource = LOCALE_RESOURCES[code]
      expect(resource).toBeDefined()
      for (const ns of CORE_NAMESPACES) {
        expect(Object.keys(resource[ns]).sort()).toEqual(Object.keys(en[ns]).sort())
      }
    }
  })

  // CLDR plural categories. i18next appends these as `_one`/`_many`/… suffixes and
  // picks the right one at runtime per the active locale's plural rules. English only
  // uses `_one`/`_other`, but richer locales (Romance `_many`, Slavic `_few`/`_many`,
  // Arabic `_zero`/`_two`/…) legitimately declare more variants of the SAME base. The
  // type system already models this (see CldrPluralKeys in en.ts); the runtime guard
  // must match, so it checks the plural BASE rather than the exact suffixed key.
  const CLDR_PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other']

  /** `dayWithCount_many` → `dayWithCount`; undefined when there is no plural suffix. */
  const pluralBase = (key: string): string | undefined => {
    const idx = key.lastIndexOf('_')
    if (idx === -1) {
      return undefined
    }
    return CLDR_PLURAL_CATEGORIES.includes(key.slice(idx + 1)) ? key.slice(0, idx) : undefined
  }

  /** English declares the key directly, or (for a plural key) some variant of its base. */
  const englishHasKeyOrPluralBase = (enNamespace: Record<string, unknown>, key: string): boolean => {
    if (Object.prototype.hasOwnProperty.call(enNamespace, key)) {
      return true
    }
    const base = pluralBase(key)
    if (!base) {
      return false
    }
    return CLDR_PLURAL_CATEGORIES.some((category) =>
      Object.prototype.hasOwnProperty.call(enNamespace, `${base}_${category}`),
    )
  }

  it('never defines a surface-namespace key that does not exist in English (typo/extra guard)', () => {
    for (const { code } of SUPPORTED_LOCALES) {
      const resource = LOCALE_RESOURCES[code] as Record<string, Record<string, string> | undefined>
      for (const ns of Object.keys(resource)) {
        const enNamespace = (en as Record<string, Record<string, string>>)[ns]
        // Every namespace a locale provides must exist in English…
        expect(enNamespace).toBeDefined()
        // …and every key it provides must exist in the English base — allowing richer
        // CLDR plural-category variants of a base English declares (e.g. `_many`).
        for (const key of Object.keys(resource[ns] ?? {})) {
          if (!englishHasKeyOrPluralBase(enNamespace, key)) {
            throw new Error(`Locale "${code}" namespace "${ns}" defines key "${key}" absent from English`)
          }
        }
      }
    }
  })

  it('falls back to English when a key is missing in the active language', async () => {
    const instance = await createInstance()
    await instance.changeLanguage('pt-PT')
    // Force a lookup on a key only guaranteed to resolve via the en fallback by
    // temporarily asking for a namespaced key; every real key exists, so we
    // assert a known key resolves and a nonexistent key returns its own name.
    expect(instance.t('common:save')).toBe('Guardar')
    expect(instance.t('common:__does_not_exist__')).toBe('__does_not_exist__')

    // A locale that defines no override for an arbitrary missing key still
    // yields English for defined keys.
    await instance.changeLanguage('xx-unsupported')
    expect(instance.t('common:save')).toBe(en.common.save)
  })

  it('resolves real (non-English) translations in pt-PT', async () => {
    const instance = await createInstance()
    await instance.changeLanguage('pt-PT')
    expect(instance.t('common:save')).toBe('Guardar')
    expect(instance.t('navigation:files')).toBe('Ficheiros')
    expect(instance.t('account:signIn')).toBe('Iniciar sessão')
    // Must NOT equal the English source string.
    expect(instance.t('common:save')).not.toBe(en.common.save)
  })

  it('resolves real translations in a sample of other locales', async () => {
    const instance = await createInstance()

    await instance.changeLanguage('de')
    expect(instance.t('common:save')).toBe('Speichern')

    await instance.changeLanguage('ja')
    expect(instance.t('navigation:notes')).toBe('ノート')

    await instance.changeLanguage('ar')
    expect(instance.t('account:signIn')).toBe('تسجيل الدخول')

    await instance.changeLanguage('zh-CN')
    expect(instance.t('common:delete')).toBe('删除')
  })

  it('marks Arabic as right-to-left and others as left-to-right', () => {
    expect(getLocaleDirection('ar')).toBe('rtl')
    expect(getLocaleDirection('en')).toBe('ltr')
    expect(getLocaleDirection('pt-PT')).toBe('ltr')
    expect(getLocaleDescriptor('ar').nativeName).toBe('العربية')
  })

  it('resolves descriptors for region variants via the primary subtag', () => {
    // e.g. pt-AO is not registered; it should fall back to a pt-* descriptor.
    expect(getLocaleDescriptor('pt-AO').code.startsWith('pt')).toBe(true)
    // Unknown languages fall back to English.
    expect(getLocaleDescriptor('zz').code).toBe('en')
  })
})
