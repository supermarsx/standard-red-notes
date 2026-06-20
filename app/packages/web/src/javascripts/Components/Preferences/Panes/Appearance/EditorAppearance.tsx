import { WebApplication } from '@/Application/WebApplication'
import Dropdown from '@/Components/Dropdown/Dropdown'
import Icon from '@/Components/Icon/Icon'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Switch from '@/Components/Switch/Switch'
import {
  classNames,
  EditorFontSize,
  EditorLineHeight,
  EditorLineWidth,
  LocalPrefKey,
  PrefKey,
} from '@standardnotes/snjs'
import { ChangeEventHandler, useCallback, useEffect, useMemo, useState } from 'react'
import { Subtitle, Title, Text } from '../../PreferencesComponents/Content'
import PreferencesGroup from '../../PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '../../PreferencesComponents/PreferencesSegment'
import { CHANGE_EDITOR_WIDTH_COMMAND } from '@standardnotes/ui-services'
import { useLocalPreference } from '../../../../Hooks/usePreference'
import usePreference from '../../../../Hooks/usePreference'
import {
  BuiltInEditorFonts,
  getGoogleFontName,
  isGoogleFontValue,
  isLocalFontAccessSupported,
  LocalFontEntry,
  makeGoogleFontValue,
  queryLocalFonts,
} from '@/Utils/editorFont'

type Props = {
  application: WebApplication
}

const inputClasses = classNames(
  'w-full min-w-55 rounded border border-solid border-passive-3 bg-default px-2 py-1.5 text-base md:w-auto md:translucent-ui:bg-transparent lg:text-sm',
  'focus-within:ring-2 focus-within:ring-info',
)

type FontMode = 'default' | 'builtin' | 'local' | 'google'

const EditorFontSelector = ({ application }: Props) => {
  const fontFamily = usePreference(PrefKey.EditorFontFamily)

  const setFontFamily = useCallback(
    (value: string) => {
      void application.setPreference(PrefKey.EditorFontFamily, value)
    },
    [application],
  )

  const localFontsSupported = useMemo(() => isLocalFontAccessSupported(), [])

  const [localFonts, setLocalFonts] = useState<LocalFontEntry[]>([])
  const [localFontsLoaded, setLocalFontsLoaded] = useState(false)

  // Derive the initial UI mode from the stored value.
  const initialMode: FontMode = useMemo(() => {
    if (!fontFamily) {
      return 'default'
    }
    if (isGoogleFontValue(fontFamily)) {
      return 'google'
    }
    const matchesBuiltIn = Object.values(BuiltInEditorFonts).includes(
      fontFamily as (typeof BuiltInEditorFonts)[keyof typeof BuiltInEditorFonts],
    )
    return matchesBuiltIn ? 'builtin' : 'local'
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [mode, setMode] = useState<FontMode>(initialMode)
  const [googleFontInput, setGoogleFontInput] = useState(isGoogleFontValue(fontFamily) ? getGoogleFontName(fontFamily) : '')
  const [localFontInput, setLocalFontInput] = useState(
    fontFamily && !isGoogleFontValue(fontFamily) ? fontFamily : '',
  )

  const modeOptions = useMemo(() => {
    const options = [
      { label: 'Default (theme)', value: 'default' },
      { label: 'Built-in font', value: 'builtin' },
      { label: 'Local / system font', value: 'local' },
      { label: 'Google Font', value: 'google' },
    ]
    return options
  }, [])

  const builtInOptions = useMemo(
    () => [
      { label: 'Sans-serif', value: BuiltInEditorFonts.Sans },
      { label: 'Serif', value: BuiltInEditorFonts.Serif },
      { label: 'Monospace', value: BuiltInEditorFonts.Monospace },
    ],
    [],
  )

  const handleModeChange = useCallback(
    (value: string) => {
      const nextMode = value as FontMode
      setMode(nextMode)
      if (nextMode === 'default') {
        setFontFamily('')
      } else if (nextMode === 'builtin') {
        setFontFamily(BuiltInEditorFonts.Sans)
      } else if (nextMode === 'local') {
        setFontFamily(localFontInput.trim())
      } else if (nextMode === 'google') {
        setFontFamily(googleFontInput.trim() ? makeGoogleFontValue(googleFontInput) : '')
      }
    },
    [googleFontInput, localFontInput, setFontFamily],
  )

  const loadLocalFonts = useCallback(async () => {
    const fonts = await queryLocalFonts()
    setLocalFonts(fonts)
    setLocalFontsLoaded(true)
  }, [])

  // If the user lands on local mode and the API is supported, offer the list.
  useEffect(() => {
    if (mode === 'local' && localFontsSupported && !localFontsLoaded) {
      void loadLocalFonts()
    }
  }, [mode, localFontsSupported, localFontsLoaded, loadLocalFonts])

  const handleLocalInputChange: ChangeEventHandler<HTMLInputElement> = (event) => {
    const value = event.currentTarget.value
    setLocalFontInput(value)
    setFontFamily(value.trim())
  }

  const handleLocalDropdownChange = useCallback(
    (value: string) => {
      setLocalFontInput(value)
      setFontFamily(value)
    },
    [setFontFamily],
  )

  const handleGoogleInputChange: ChangeEventHandler<HTMLInputElement> = (event) => {
    const value = event.currentTarget.value
    setGoogleFontInput(value)
    setFontFamily(value.trim() ? makeGoogleFontValue(value) : '')
  }

  const localFontDropdownOptions = useMemo(
    () => localFonts.map((font) => ({ label: font.family, value: font.family })),
    [localFonts],
  )

  const builtInValue = builtInOptions.some((option) => option.value === fontFamily)
    ? fontFamily
    : BuiltInEditorFonts.Sans

  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <Title>Editor Font</Title>
        <div className="mt-2">
          <Subtitle>Font family</Subtitle>
          <Text>Sets the font used for the editor text in plaintext, Markdown preview and Super notes</Text>
          <div className="mt-2">
            <Dropdown
              label="Select the editor font source"
              items={modeOptions}
              value={mode}
              onChange={handleModeChange}
            />
          </div>

          {mode === 'builtin' && (
            <div className="mt-2">
              <Dropdown
                label="Select a built-in font"
                items={builtInOptions}
                value={builtInValue}
                onChange={setFontFamily}
              />
            </div>
          )}

          {mode === 'local' && (
            <div className="mt-2 flex flex-col gap-2">
              {localFontsSupported && localFontDropdownOptions.length > 0 && (
                <Dropdown
                  label="Select an installed local font"
                  items={localFontDropdownOptions}
                  value={localFontInput}
                  onChange={handleLocalDropdownChange}
                />
              )}
              <input
                className={inputClasses}
                placeholder="e.g. Helvetica Neue"
                value={localFontInput}
                onChange={handleLocalInputChange}
                spellCheck={false}
              />
              <Text>
                {localFontsSupported
                  ? 'Pick from your installed fonts above, or type any installed font name.'
                  : 'Type the name of any font installed on this device. Your browser does not support listing installed fonts, so the name must be entered manually.'}
              </Text>
            </div>
          )}

          {mode === 'google' && (
            <div className="mt-2 flex flex-col gap-2">
              <input
                className={inputClasses}
                placeholder="e.g. Inter"
                value={googleFontInput}
                onChange={handleGoogleInputChange}
                spellCheck={false}
              />
              <Text>
                Loads the font from Google's servers (fonts.googleapis.com), which is a third-party network request.
                Privacy-conscious users may prefer a local / system font instead.
              </Text>
            </div>
          )}
        </div>
      </PreferencesSegment>
    </PreferencesGroup>
  )
}

const EditorDefaults = ({ application }: Props) => {
  const [lineHeight, setLineHeight] = useLocalPreference(LocalPrefKey.EditorLineHeight)

  const handleLineHeightChange = (value: string) => {
    setLineHeight(value as EditorLineHeight)
  }

  const lineHeightDropdownOptions = useMemo(
    () =>
      Object.values(EditorLineHeight).map((lineHeight) => ({
        label: lineHeight,
        value: lineHeight,
      })),
    [],
  )

  const [monospaceFont, setMonospaceFont] = useLocalPreference(LocalPrefKey.EditorMonospaceEnabled)
  const toggleMonospaceFont = () => {
    setMonospaceFont(!monospaceFont)
  }

  const [ligaturesEnabled, setLigaturesEnabled] = useLocalPreference(LocalPrefKey.EditorLigaturesEnabled)
  const toggleLigatures = () => {
    setLigaturesEnabled(!ligaturesEnabled)
  }

  const [fontSize, setFontSize] = useLocalPreference(LocalPrefKey.EditorFontSize)
  const handleFontSizeChange = (value: string) => {
    setFontSize(value as EditorFontSize)
  }

  const fontSizeDropdownOptions = useMemo(
    () =>
      Object.values(EditorFontSize).map((fontSize) => ({
        label: fontSize,
        value: fontSize,
      })),
    [],
  )

  const [editorWidth] = useLocalPreference(LocalPrefKey.EditorLineWidth)

  const toggleEditorWidthModal = useCallback(() => {
    application.keyboardService.triggerCommand(CHANGE_EDITOR_WIDTH_COMMAND, true)
  }, [application.keyboardService])

  return (
    <>
      <PreferencesGroup>
        <PreferencesSegment>
          <Title>Editor</Title>
          <div className="mt-2">
            <div className="flex justify-between gap-2 md:items-center">
              <div className="flex flex-col">
                <Subtitle>Monospace Font</Subtitle>
                <Text>Toggles the font style in plaintext and Super notes</Text>
              </div>
              <Switch onChange={toggleMonospaceFont} checked={monospaceFont} />
            </div>
            <HorizontalSeparator classes="my-4" />
            <div className="flex justify-between gap-2 md:items-center">
              <div className="flex flex-col">
                <Subtitle>Font ligatures</Subtitle>
                <Text>
                  Enables OpenType ligatures in the plaintext, Super and code editors (including coding ligatures such as
                  =&gt;, != and === for monospace fonts). Ligatures only appear if the active editor font actually
                  contains them; this setting does not bundle a ligature font.
                </Text>
              </div>
              <Switch onChange={toggleLigatures} checked={ligaturesEnabled} />
            </div>
            <HorizontalSeparator classes="my-4" />
            <div>
              <Subtitle>Font size</Subtitle>
              <Text>Sets the font size in plaintext and Super notes</Text>
              <div className="mt-2">
                <Dropdown
                  label="Select the font size for plaintext notes"
                  items={fontSizeDropdownOptions}
                  value={fontSize}
                  onChange={handleFontSizeChange}
                />
              </div>
            </div>
            <HorizontalSeparator classes="my-4" />
            <div>
              <Subtitle>Line height</Subtitle>
              <Text>Sets the line height (leading) in plaintext and Super notes</Text>
              <div className="mt-2">
                <Dropdown
                  label="Select the line height for plaintext notes"
                  items={lineHeightDropdownOptions}
                  value={lineHeight}
                  onChange={handleLineHeightChange}
                />
              </div>
            </div>
            <HorizontalSeparator classes="my-4" />
            <div>
              <Subtitle>Editor width</Subtitle>
              <Text>Sets the max editor width for all notes</Text>
              <div className="mt-2">
                <button
                  className="flex w-full min-w-55 items-center justify-between rounded border border-border bg-default px-3.5 py-1.5 text-left text-base text-foreground md:w-fit lg:text-sm"
                  onClick={toggleEditorWidthModal}
                >
                  {editorWidth === EditorLineWidth.FullWidth ? 'Full width' : editorWidth}
                  <Icon type="chevron-down" size="normal" />
                </button>
              </div>
            </div>
          </div>
        </PreferencesSegment>
      </PreferencesGroup>
      <EditorFontSelector application={application} />
    </>
  )
}

export default EditorDefaults
