import { FunctionComponent, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesGroup from '../../PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '../../PreferencesComponents/PreferencesSegment'
import Dropdown from '@/Components/Dropdown/Dropdown'
import { DropdownItem } from '@/Components/Dropdown/DropdownItem'
import { SUPPORTED_LOCALES } from '@/Internationalization/Locales'
import { changeLanguage } from '@/Internationalization/i18n'

/**
 * Language switcher (Preferences → General). Lists the supported locales by
 * their NATIVE names. Selecting one switches the UI language live (via
 * react-i18next) and persists it to localStorage, so it survives reloads.
 */
const Language: FunctionComponent = () => {
  const { t, i18n } = useTranslation('preferences')

  const items = useMemo<DropdownItem[]>(
    () =>
      SUPPORTED_LOCALES.map((locale) => ({
        label: locale.nativeName,
        value: locale.code,
      })),
    [],
  )

  // Resolve the dropdown's current value to a supported code (e.g. an
  // un-suffixed `pt` resolves to whichever pt variant is active).
  const currentValue = useMemo(() => {
    const active = i18n.resolvedLanguage || i18n.language
    const exact = SUPPORTED_LOCALES.find((locale) => locale.code === active)
    return exact ? exact.code : 'en'
  }, [i18n.resolvedLanguage, i18n.language])

  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <Title>{t('languageTitle')}</Title>
        <div className="flex flex-col gap-2">
          <Subtitle>{t('language')}</Subtitle>
          <Text>{t('languageDescription')}</Text>
          <div className="mt-2">
            <Dropdown
              label={t('language')}
              items={items}
              value={currentValue}
              onChange={(value) => {
                void changeLanguage(value)
              }}
            />
          </div>
        </div>
      </PreferencesSegment>
    </PreferencesGroup>
  )
}

export default Language
