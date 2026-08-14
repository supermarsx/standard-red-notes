import Dropdown from '@/Components/Dropdown/Dropdown'
import { DropdownItem } from '@/Components/Dropdown/DropdownItem'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Switch from '@/Components/Switch/Switch'
import { WebApplication } from '@/Application/WebApplication'
import { LocalPrefKey } from '@standardnotes/snjs'
import { observer } from 'mobx-react-lite'
import { FunctionComponent, useState } from 'react'
import { Subtitle, Title, Text } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesPane from '../PreferencesComponents/PreferencesPane'
import PreferencesGroup from '../PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '../PreferencesComponents/PreferencesSegment'
import PreferencesSubtabs, { PreferencesSubtab } from '../PreferencesComponents/PreferencesSubtabs'
import EditorAppearance from './Appearance/EditorAppearance'
import ColorSchemeModeControl from './Appearance/ColorSchemeModeControl'
import BaseThemePalette from './Appearance/BaseThemePalette'
import CustomThemesSection from './Appearance/CustomThemes/CustomThemesSection'
import StyleProfiles from './Appearance/StyleProfiles/StyleProfiles'
import { useTabState } from '@/Components/Tabs/useTabState'
import { useLocalPreference } from '@/Hooks/usePreference'
import { loadNewTabBehavior, NewTabBehavior, saveNewTabBehavior } from '@/Tabs/newTabSettings'
import { achievements, METRICS } from '@/Achievements'

type Props = {
  application: WebApplication
}

const Appearance: FunctionComponent<Props> = ({ application }) => {
  const [useTranslucentUI, setUseTranslucentUI] = useLocalPreference(LocalPrefKey.UseTranslucentUI)
  const toggleTranslucentUI = () => {
    setUseTranslucentUI(!useTranslucentUI)
    achievements.markEvent(METRICS.appearanceCustomized)
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
    achievements.markEvent(METRICS.appearanceCustomized)
  }

  const tabState = useTabState({ defaultTab: 'appearance' })

  const appearanceTab = (
    <>
      <PreferencesGroup>
        <PreferencesSegment>
          <Title>Themes</Title>
          <div className="mt-2">
            <ColorSchemeModeControl />
            <BaseThemePalette application={application} />
            <HorizontalSeparator classes="my-4" />
            <div className="flex justify-between gap-2 md:items-center">
              <div className="flex flex-col">
                <Subtitle>Disable translucent UI</Subtitle>
                <Text>Use opaque style for UI elements instead of translucency</Text>
              </div>
              <Switch onChange={toggleTranslucentUI} checked={!useTranslucentUI} />
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
              What the editor tab bar's "+" button does. "New note" creates a fresh note (the default); "Empty tab"
              opens a blank placeholder you can turn into a note or fill from the notes list.
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
    </>
  )

  const tabs: PreferencesSubtab[] = [
    {
      id: 'appearance',
      title: 'Appearance',
      icon: 'themes',
      content: appearanceTab,
    },
    {
      id: 'style-profiles',
      title: 'Style profiles',
      icon: 'tune',
      content: <StyleProfiles />,
    },
  ]

  return (
    <PreferencesPane>
      <PreferencesSubtabs state={tabState} tabs={tabs} />
    </PreferencesPane>
  )
}

export default observer(Appearance)
