import { PrefKey, Platform, PrefValue } from '@standardnotes/snjs'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import { WebApplication } from '@/Application/WebApplication'
import { FunctionComponent, useMemo, useState } from 'react'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Switch from '@/Components/Switch/Switch'
import PreferencesGroup from '../../PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '../../PreferencesComponents/PreferencesSegment'
import usePreference from '@/Hooks/usePreference'
import Dropdown from '@/Components/Dropdown/Dropdown'
import { DropdownItem } from '@/Components/Dropdown/DropdownItem'
import { MutuallyExclusiveMediaQueryBreakpoints, useMediaQuery } from '@/Hooks/useMediaQuery'
import {
  SUPER_TOOLBAR_AUTO_HIDE_PREF_KEY,
  normalizeSuperToolbarAutoHide,
} from '@/Components/SuperEditor/Plugins/ToolbarPlugin/ToolbarAutoHidePreference'

type Props = {
  application: WebApplication
}

export const AndroidConfirmBeforeExitKey = 'ConfirmBeforeExit'

const Defaults: FunctionComponent<Props> = ({ application }) => {
  const [androidConfirmBeforeExit, setAndroidConfirmBeforeExit] = useState(
    () => (application.getValue(AndroidConfirmBeforeExitKey) as boolean) ?? true,
  )

  const isMobile = useMediaQuery(MutuallyExclusiveMediaQueryBreakpoints.sm)

  const addNoteToParentFolders = usePreference(PrefKey.NoteAddToParentFolders)

  const alwaysShowSuperToolbar = usePreference(PrefKey.AlwaysShowSuperToolbar)
  // The key and what an unset value means both come from
  // `ToolbarAutoHidePreference.ts`, which is also what the toolbar reads, so this
  // switch and the toolbar cannot disagree. Only an explicit `true` is on.
  const superToolbarAutoHide = normalizeSuperToolbarAutoHide(usePreference(SUPER_TOOLBAR_AUTO_HIDE_PREF_KEY))
  const defaultSuperImageAlignment = usePreference(PrefKey.SuperNoteImageAlignment)
  const imageAlignmentOptions = useMemo(
    (): DropdownItem[] => [
      {
        icon: 'format-align-left',
        label: 'Left align',
        value: 'left',
      },
      {
        icon: 'format-align-center',
        label: 'Center align',
        value: 'center',
      },
      {
        icon: 'format-align-right',
        label: 'Right align',
        value: 'right',
      },
    ],
    [],
  )

  const toggleAndroidConfirmBeforeExit = () => {
    const newValue = !androidConfirmBeforeExit
    setAndroidConfirmBeforeExit(newValue)
    application.setValue(AndroidConfirmBeforeExitKey, newValue)
  }

  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <Title>Defaults</Title>
        {application.platform === Platform.Android && (
          <>
            <div className="flex justify-between gap-2 md:items-center">
              <div className="flex flex-col">
                <Subtitle>Always ask before closing app (Android)</Subtitle>
                <Text>Whether a confirmation dialog should be shown before closing the app.</Text>
              </div>
              <Switch onChange={toggleAndroidConfirmBeforeExit} checked={androidConfirmBeforeExit} />
            </div>
            <HorizontalSeparator classes="my-4" />
          </>
        )}
        <div className="flex justify-between gap-2 md:items-center">
          <div className="flex flex-col">
            <Subtitle>Add all parent tags when adding a nested tag to a note</Subtitle>
            <Text>When enabled, adding a nested tag to a note will automatically add all associated parent tags.</Text>
          </div>
          <Switch
            onChange={() => {
              application.setPreference(PrefKey.NoteAddToParentFolders, !addNoteToParentFolders).catch(console.error)
            }}
            checked={addNoteToParentFolders}
          />
        </div>
        <HorizontalSeparator classes="my-4" />
        {!isMobile && (
          <>
            <div className="flex justify-between gap-2 md:items-center">
              <div className="flex flex-col">
                <Subtitle>Use always-visible toolbar in Super notes</Subtitle>
                <Text>
                  When enabled, the Super toolbar will always be shown at the top of the note. It can be temporarily
                  toggled using Cmd/Ctrl+Shift+K. When disabled, the Super toolbar will only be shown as a floating
                  toolbar when text is selected.
                </Text>
              </div>
              <Switch
                onChange={() => {
                  application
                    .setPreference(PrefKey.AlwaysShowSuperToolbar, !alwaysShowSuperToolbar)
                    .catch(console.error)
                }}
                checked={alwaysShowSuperToolbar}
              />
            </div>
            <HorizontalSeparator classes="my-4" />
            {/* Collapsing belongs to the always-visible toolbar above: the floating
                toolbar already shows only while text is selected, so with that
                setting off there is nothing here to hide. The switch is disabled
                then, and says why, rather than being a control that silently does
                nothing. It still shows what was chosen, so turning the toolbar
                back on brings the choice back with it. */}
            <div className="flex justify-between gap-2 md:items-center" data-test="super-toolbar-auto-hide-setting">
              <div className="flex flex-col">
                <Subtitle>Collapse the toolbar in Super notes</Subtitle>
                <Text>
                  When enabled, the toolbar at the top of the note shrinks to its row of tabs and gives the rest of the
                  space to your note. Point at a tab, or click one, to bring its commands back; they hide again when you
                  return to the note. The small button at the bottom right of the commands switches this too, and
                  Cmd/Ctrl+Shift+K takes you straight into them.
                </Text>
                {!alwaysShowSuperToolbar && (
                  <div data-test="super-toolbar-auto-hide-unavailable">
                    <Text className="text-passive-0 mt-1">
                      Turn on the always-visible toolbar above to use this. The floating toolbar already appears only
                      when text is selected.
                    </Text>
                  </div>
                )}
              </div>
              <Switch
                onChange={(enabled) => {
                  application.setPreference(SUPER_TOOLBAR_AUTO_HIDE_PREF_KEY, enabled).catch(console.error)
                }}
                checked={superToolbarAutoHide}
                disabled={!alwaysShowSuperToolbar}
              />
            </div>
            <HorizontalSeparator classes="my-4" />
          </>
        )}
        <div>
          <Subtitle>Default image alignment in Super notes</Subtitle>
          <div className="mt-2">
            <Dropdown
              label="Default image alignment in super notes"
              items={imageAlignmentOptions}
              value={defaultSuperImageAlignment}
              onChange={(alignment) => {
                application
                  .setPreference(
                    PrefKey.SuperNoteImageAlignment,
                    alignment as PrefValue[PrefKey.SuperNoteImageAlignment],
                  )
                  .catch(console.error)
              }}
            />
          </div>
        </div>
      </PreferencesSegment>
    </PreferencesGroup>
  )
}

export default Defaults
