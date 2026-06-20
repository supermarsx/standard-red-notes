import { FunctionComponent, useCallback, useEffect, useMemo, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { PrefKey } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Switch from '@/Components/Switch/Switch'
import Checkbox from '@/Components/Checkbox/Checkbox'
import PreferencesGroup from '../../PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '../../PreferencesComponents/PreferencesSegment'
import usePreference from '@/Hooks/usePreference'
import { isDesktopApplication } from '@/Utils'
import {
  asSpellcheckerDevice,
  SpellcheckerDevice,
  SpellcheckerLanguageDescriptor,
} from '@/Application/Device/SpellcheckerDevice'

type Props = {
  application: WebApplication
}

const Spellcheck: FunctionComponent<Props> = ({ application }) => {
  const spellcheck = usePreference(PrefKey.EditorSpellcheck)

  const toggleSpellcheck = useCallback(() => {
    application.toggleGlobalSpellcheck().catch(console.error)
  }, [application])

  const spellcheckerDevice: SpellcheckerDevice | undefined = useMemo(() => {
    if (!isDesktopApplication()) {
      return undefined
    }
    return asSpellcheckerDevice(application.desktopDevice)
  }, [application])

  const managerAvailable = useMemo(
    () => spellcheckerDevice?.isSpellCheckerManagerAvailable() ?? false,
    [spellcheckerDevice],
  )

  const [languages, setLanguages] = useState<SpellcheckerLanguageDescriptor[]>([])

  useEffect(() => {
    if (spellcheckerDevice && managerAvailable) {
      setLanguages(spellcheckerDevice.getSpellCheckerLanguages())
    }
  }, [spellcheckerDevice, managerAvailable])

  const toggleLanguage = useCallback(
    (code: string) => {
      if (!spellcheckerDevice) {
        return
      }
      const updated = languages.map((language) =>
        language.code === code ? { ...language, enabled: !language.enabled } : language,
      )
      const enabledCodes = updated.filter((language) => language.enabled).map((language) => language.code)
      spellcheckerDevice.setSpellCheckerLanguages(enabledCodes)
      // Re-read from the device so the displayed state reflects what was
      // actually persisted/applied (e.g. unsupported codes dropped).
      setLanguages(spellcheckerDevice.getSpellCheckerLanguages())
    },
    [languages, spellcheckerDevice],
  )

  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <Title>Spellcheck</Title>
        <div className="flex justify-between gap-2 md:items-center">
          <div className="flex flex-col">
            <Subtitle>Spellcheck by default</Subtitle>
            <Text>
              The default spellcheck value for new notes. Spellcheck can be configured per note from the note context
              menu. Spellcheck may degrade overall typing performance with long notes.
            </Text>
          </div>
          <Switch onChange={toggleSpellcheck} checked={spellcheck} />
        </div>
        <HorizontalSeparator classes="my-4" />

        {!isDesktopApplication() && (
          <div>
            <Subtitle>Spellcheck languages</Subtitle>
            <Text>
              In the web app, spellcheck languages follow your browser and operating system settings and cannot be
              chosen here. Install the desktop app to select multiple spellcheck languages at once.
            </Text>
          </div>
        )}

        {isDesktopApplication() && !managerAvailable && (
          <div>
            <Subtitle>Spellcheck languages</Subtitle>
            <Text>
              On macOS, spellcheck languages are managed by the operating system. Adjust them in System Settings &gt;
              Keyboard &gt; Text Input &gt; Spelling.
            </Text>
          </div>
        )}

        {isDesktopApplication() && managerAvailable && (
          <div>
            <Subtitle>Spellcheck languages</Subtitle>
            <Text>
              Select one or more languages to spellcheck simultaneously. Changes take effect immediately and persist
              across restarts.
            </Text>
            {languages.length === 0 ? (
              <Text className="mt-2">No spellcheck languages are available on this system.</Text>
            ) : (
              <div className="mt-3 grid grid-cols-1 gap-x-4 md:grid-cols-2">
                {languages.map((language) => (
                  <Checkbox
                    key={language.code}
                    name={`spellcheck-language-${language.code}`}
                    label={language.name}
                    checked={language.enabled}
                    onChange={() => toggleLanguage(language.code)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </PreferencesSegment>
    </PreferencesGroup>
  )
}

export default observer(Spellcheck)
