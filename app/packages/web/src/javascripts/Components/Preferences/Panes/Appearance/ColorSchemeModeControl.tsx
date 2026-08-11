import { FunctionComponent } from 'react'
import { ColorSchemeMode, LocalPrefKey } from '@standardnotes/snjs'
import RadioButtonGroup from '@/Components/RadioButtonGroup/RadioButtonGroup'
import { Subtitle, Text } from '@/Components/Preferences/PreferencesComponents/Content'
import { useLocalPreference } from '@/Hooks/usePreference'
import { useApplication } from '@/Components/ApplicationProvider'

const COLOR_SCHEME_MODE_ITEMS: { label: string; value: ColorSchemeMode }[] = [
  { label: 'Manual', value: 'manual' },
  { label: 'Auto', value: 'auto' },
  { label: 'Light', value: 'light' },
  { label: 'Dark', value: 'dark' },
]

const ColorSchemeModeControl: FunctionComponent = () => {
  const application = useApplication()
  const [colorSchemeMode] = useLocalPreference(LocalPrefKey.ColorSchemeMode)

  return (
    <div>
      <Subtitle>Color scheme</Subtitle>
      <Text>
        Manual keeps the theme selected in Quick Settings. Auto follows your system appearance. Light uses Standard
        Blue, Dark uses Standard Red. When your system preference can't be determined, Auto falls back to Dark.
      </Text>
      <div className="mt-2">
        <RadioButtonGroup
          items={COLOR_SCHEME_MODE_ITEMS}
          value={colorSchemeMode}
          onChange={(value) => application.themeManager.setColorSchemeMode(value)}
        />
      </div>
    </div>
  )
}

export default ColorSchemeModeControl
