import { WebApplication } from '@/Application/WebApplication'
import { observer } from 'mobx-react-lite'
import { FunctionComponent, useCallback, useEffect, useMemo, useState } from 'react'
import {
  ConfigurableShortcut,
  isMobilePlatform,
  KEYBOARD_COMMAND_CATALOG,
  KeyboardShortcutCategory,
  SerializedKeyboardShortcut,
} from '@standardnotes/ui-services'
import PreferencesPane from '../../PreferencesComponents/PreferencesPane'
import PreferencesGroup from '../../PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '../../PreferencesComponents/PreferencesSegment'
import { Subtitle, Text, Title } from '../../PreferencesComponents/Content'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import { achievements, METRICS } from '@/Achievements'
import Button from '@/Components/Button/Button'
import Icon from '@/Components/Icon/Icon'
import { KeyboardShortcutIndicator } from '@/Components/KeyboardShortcutIndicator/KeyboardShortcutIndicator'
import ShortcutCaptureInput from './ShortcutCaptureInput'

type Props = {
  application: WebApplication
}

const CATEGORY_ORDER: KeyboardShortcutCategory[] = [
  'General',
  'Notes list',
  'Current note',
  'Super notes',
  'Formatting',
]

type Row = ConfigurableShortcut & { label: string; category: KeyboardShortcutCategory }

const ShortcutRow: FunctionComponent<{
  row: Row
  application: WebApplication
  isCapturing: boolean
  onStartCapture: () => void
  onStopCapture: () => void
}> = ({ row, application, isCapturing, onStartCapture, onStopCapture }) => {
  const keyboardService = application.keyboardService
  const [conflictLabel, setConflictLabel] = useState<string | null>(null)

  const labelForCommandKey = useCallback((commandKey: string): string => {
    const entry = KEYBOARD_COMMAND_CATALOG.find((entry) => entry.command.description === commandKey)
    return entry?.label ?? commandKey
  }, [])

  const handleCapture = useCallback(
    (shortcut: SerializedKeyboardShortcut) => {
      const conflictKey = keyboardService.findConflictingCommandKey(shortcut, row.commandKey)
      if (conflictKey) {
        setConflictLabel(labelForCommandKey(conflictKey))
        return
      }
      setConflictLabel(null)
      keyboardService.setShortcutOverride(row.commandKey, shortcut)
      achievements.markEvent(METRICS.shortcutsChanged)
      onStopCapture()
    },
    [keyboardService, row.commandKey, labelForCommandKey, onStopCapture],
  )

  const handleCancel = useCallback(() => {
    setConflictLabel(null)
    onStopCapture()
  }, [onStopCapture])

  const handleReset = useCallback(() => {
    setConflictLabel(null)
    keyboardService.resetShortcutOverride(row.commandKey)
  }, [keyboardService, row.commandKey])

  return (
    <div className="flex flex-col gap-1 py-2.5">
      <div className="flex items-center gap-2">
        <div className="flex flex-col">
          <span className="text-base lg:text-sm">{row.label}</span>
          {row.isOverridden && <span className="text-xs text-passive-1">Customized</span>}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {isCapturing ? (
            <ShortcutCaptureInput
              platform={application.platform}
              onCapture={handleCapture}
              onCancel={handleCancel}
            />
          ) : (
            <button
              className="flex min-h-9 items-center gap-1 rounded border border-border bg-default px-3 py-1.5 hover:bg-contrast"
              onClick={onStartCapture}
              aria-label={`Change shortcut for ${row.label}`}
            >
              <KeyboardShortcutIndicator shortcut={row.effectiveShortcut} small={false} dimmed={false} />
            </button>
          )}
          {row.isOverridden && (
            <button
              className="rounded p-1 text-passive-1 hover:bg-contrast hover:text-text"
              onClick={handleReset}
              aria-label={`Reset ${row.label} to default`}
              title="Reset to default"
            >
              <Icon type="restore" size="medium" />
            </button>
          )}
        </div>
      </div>
      {conflictLabel && (
        <div className="text-xs text-danger">
          That shortcut is already used by &ldquo;{conflictLabel}&rdquo;. Choose a different combination.
        </div>
      )}
    </div>
  )
}

const Shortcuts: FunctionComponent<Props> = ({ application }) => {
  const keyboardService = application.keyboardService
  const [version, setVersion] = useState(0)
  const [capturingKey, setCapturingKey] = useState<string | null>(null)

  // Re-render whenever overrides change (set/reset) so chords update live.
  useEffect(() => {
    return keyboardService.addOverrideChangeObserver(() => setVersion((value) => value + 1))
  }, [keyboardService])

  // Prevent the global KeyboardService from firing commands while the user is
  // capturing a new chord, otherwise the captured keys would also trigger actions.
  useEffect(() => {
    if (capturingKey) {
      keyboardService.disableEventHandling()
      return () => keyboardService.enableEventHandling()
    }
    return undefined
  }, [capturingKey, keyboardService])

  const grouped = useMemo(() => {
    // version is intentionally a dependency to recompute after overrides change.
    void version
    const configurable = keyboardService.getConfigurableShortcuts()
    const byKey = new Map(configurable.map((item) => [item.commandKey, item]))

    const groups = new Map<KeyboardShortcutCategory, Row[]>()
    for (const entry of KEYBOARD_COMMAND_CATALOG) {
      const commandKey = entry.command.description
      if (!commandKey) {
        continue
      }
      const shortcut = byKey.get(commandKey)
      if (!shortcut) {
        continue
      }
      const rows = groups.get(entry.category) ?? []
      rows.push({ ...shortcut, label: entry.label, category: entry.category })
      groups.set(entry.category, rows)
    }
    return groups
  }, [keyboardService, version])

  const hasAnyOverride = useMemo(() => {
    void version
    return keyboardService.getConfigurableShortcuts().some((item) => item.isOverridden)
  }, [keyboardService, version])

  const handleResetAll = useCallback(() => {
    keyboardService.resetAllShortcutOverrides()
  }, [keyboardService])

  if (isMobilePlatform(application.platform)) {
    return (
      <PreferencesPane>
        <PreferencesGroup>
          <PreferencesSegment>
            <Title>Keyboard shortcuts</Title>
            <Text className="mt-2">
              Keyboard shortcuts are only available on desktop and web with a physical keyboard.
            </Text>
          </PreferencesSegment>
        </PreferencesGroup>
      </PreferencesPane>
    )
  }

  return (
    <PreferencesPane>
      <PreferencesGroup>
        <PreferencesSegment>
          <div className="flex items-center justify-between gap-2">
            <Title>Keyboard shortcuts</Title>
            <Button
              label="Reset all to default"
              onClick={handleResetAll}
              disabled={!hasAnyOverride}
              className="min-w-fit"
            />
          </div>
          <Text className="mt-2">
            Click a shortcut to record a new key combination. Combinations already used by another command are
            rejected. Overrides are saved on this device only.
          </Text>
        </PreferencesSegment>
      </PreferencesGroup>

      {CATEGORY_ORDER.map((category) => {
        const rows = grouped.get(category)
        if (!rows || rows.length === 0) {
          return null
        }
        return (
          <PreferencesGroup key={category}>
            <PreferencesSegment>
              <Subtitle>{category}</Subtitle>
              <div className="mt-1">
                {rows.map((row, index) => (
                  <div key={row.commandKey}>
                    {index > 0 && <HorizontalSeparator classes="my-1" />}
                    <ShortcutRow
                      row={row}
                      application={application}
                      isCapturing={capturingKey === row.commandKey}
                      onStartCapture={() => setCapturingKey(row.commandKey)}
                      onStopCapture={() => setCapturingKey(null)}
                    />
                  </div>
                ))}
              </div>
            </PreferencesSegment>
          </PreferencesGroup>
        )
      })}
    </PreferencesPane>
  )
}

export default observer(Shortcuts)
