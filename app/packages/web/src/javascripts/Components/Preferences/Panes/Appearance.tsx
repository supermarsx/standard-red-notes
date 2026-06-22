import Dropdown from '@/Components/Dropdown/Dropdown'
import { DropdownItem } from '@/Components/Dropdown/DropdownItem'
import { usePremiumModal } from '@/Hooks/usePremiumModal'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Switch from '@/Components/Switch/Switch'
import { WebApplication } from '@/Application/WebApplication'
import { FeatureStatus, naturalSort, LocalPrefKey } from '@standardnotes/snjs'
import { observer } from 'mobx-react-lite'
import { FunctionComponent, useEffect, useState } from 'react'
import { Subtitle, Title, Text } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesPane from '../PreferencesComponents/PreferencesPane'
import PreferencesGroup from '../PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '../PreferencesComponents/PreferencesSegment'
import EditorAppearance from './Appearance/EditorAppearance'
import ColorSchemeModeControl from './Appearance/ColorSchemeModeControl'
import CustomThemesSection from './Appearance/CustomThemes/CustomThemesSection'
import { GetAllThemesUseCase } from '@standardnotes/ui-services'
import { useLocalPreference } from '@/Hooks/usePreference'
import { loadNewTabBehavior, NewTabBehavior, saveNewTabBehavior } from '@/Tabs/newTabSettings'

type Props = {
  application: WebApplication
}

const Appearance: FunctionComponent<Props> = ({ application }) => {
  const premiumModal = usePremiumModal()

  const [themeItems, setThemeItems] = useState<DropdownItem[]>([])

  const [autoLightTheme, setAutoLightTheme] = useLocalPreference(LocalPrefKey.AutoLightThemeIdentifier)
  const [autoDarkTheme, setAutoDarkTheme] = useLocalPreference(LocalPrefKey.AutoDarkThemeIdentifier)
  const [useDeviceSettings, setUseDeviceSettings] = useLocalPreference(LocalPrefKey.UseSystemColorScheme)

  const [useTranslucentUI, setUseTranslucentUI] = useLocalPreference(LocalPrefKey.UseTranslucentUI)
  const toggleTranslucentUI = () => {
    setUseTranslucentUI(!useTranslucentUI)
  }

  const [newTabBehavior, setNewTabBehavior] = useState<NewTabBehavior>(() => loadNewTabBehavior())
  const newTabBehaviorOptions: DropdownItem[] = [
    { label: 'New note', value: 'new-note' },
    { label: 'Empty tab', value: 'empty' },
  ]
  const changeNewTabBehavior = (value: string) => {
    const behavior = value as NewTabBehavior
    setNewTabBehavior(behavior)
    saveNewTabBehavior(behavior)
  }

  useEffect(() => {
    const usecase = new GetAllThemesUseCase(application.items)
    const { thirdParty, native } = usecase.execute({ excludeLayerable: true })

    const dropdownItems: DropdownItem[] = []

    dropdownItems.push({
      label: 'Standard Red',
      value: 'Default',
    })

    dropdownItems.push(
      ...native.map((theme) => {
        return {
          label: theme.displayName as string,
          value: theme.featureIdentifier,
        }
      }),
    )

    dropdownItems.push(
      ...thirdParty.map((theme) => {
        return {
          label: theme.displayName,
          value: theme.featureIdentifier,
        }
      }),
    )

    setThemeItems(naturalSort(dropdownItems, 'label'))
  }, [application])

  const toggleUseDeviceSettings = () => {
    setUseDeviceSettings(!useDeviceSettings)
    if (!application.preferences.getLocalValue(LocalPrefKey.AutoLightThemeIdentifier)) {
      setAutoLightTheme(autoLightTheme)
    }
    if (!application.preferences.getLocalValue(LocalPrefKey.AutoDarkThemeIdentifier)) {
      setAutoDarkTheme(autoDarkTheme)
    }
    setUseDeviceSettings(!useDeviceSettings)
  }

  const changeAutoLightTheme = (value: string) => {
    const item = themeItems.find((item) => item.value === value)
    if (item && item.icon === PremiumFeatureIconName) {
      premiumModal.activate(`${item.label} theme`)
      return
    }
    setAutoLightTheme(value)
  }

  const changeAutoDarkTheme = (value: string) => {
    const item = themeItems.find((item) => item.value === value)
    if (item && item.icon === PremiumFeatureIconName) {
      premiumModal.activate(`${item.label} theme`)
      return
    }
    setAutoDarkTheme(value)
  }

  return (
    <PreferencesPane>
      <PreferencesGroup>
        <PreferencesSegment>
          <Title>Themes</Title>
          <div className="mt-2">
            <ColorSchemeModeControl />
            <HorizontalSeparator classes="my-4" />
            <div className="flex justify-between gap-2 md:items-center">
              <div className="flex flex-col">
                <Subtitle>Disable translucent UI</Subtitle>
                <Text>Use opaque style for UI elements instead of translucency</Text>
              </div>
              <Switch onChange={toggleTranslucentUI} checked={!useTranslucentUI} />
            </div>
            <HorizontalSeparator classes="my-4" />
            <div className="flex justify-between gap-2 md:items-center">
              <div className="flex flex-col">
                <Subtitle>Use system color scheme</Subtitle>
                <Text>Automatically change active theme based on your system settings.</Text>
              </div>
              <Switch onChange={toggleUseDeviceSettings} checked={useDeviceSettings} />
            </div>
            <HorizontalSeparator classes="my-4" />
            <div>
              <Subtitle>Automatic Light Theme</Subtitle>
              <Text>Theme to be used for system light mode:</Text>
              <div className="mt-2">
                <Dropdown
                  label="Select the automatic light theme"
                  items={themeItems}
                  value={autoLightTheme}
                  onChange={changeAutoLightTheme}
                  disabled={!useDeviceSettings}
                />
              </div>
            </div>
            <HorizontalSeparator classes="my-4" />
            <div>
              <Subtitle>Automatic Dark Theme</Subtitle>
              <Text>Theme to be used for system dark mode:</Text>
              <div className="mt-2">
                <Dropdown
                  label="Select the automatic dark theme"
                  items={themeItems}
                  value={autoDarkTheme}
                  onChange={changeAutoDarkTheme}
                  disabled={!useDeviceSettings}
                />
              </div>
            </div>
            <CustomThemesSection />
          </div>
        </PreferencesSegment>
      </PreferencesGroup>
      <PreferencesGroup>
        <PreferencesSegment>
          <Title>Editor tabs</Title>
          <div className="mt-2">
            <Subtitle>New tab opens</Subtitle>
            <Text>
              What the editor tab bar's "+" button does. "New note" creates a fresh note (the default); "Empty tab" opens
              a blank placeholder you can turn into a note or fill from the notes list.
            </Text>
            <div className="mt-2">
              <Dropdown
                label="Select what the new tab button opens"
                items={newTabBehaviorOptions}
                value={newTabBehavior}
                onChange={changeNewTabBehavior}
              />
            </div>
          </div>
        </PreferencesSegment>
      </PreferencesGroup>
      <EditorAppearance application={application} />
    </PreferencesPane>
  )
}

export default observer(Appearance)
