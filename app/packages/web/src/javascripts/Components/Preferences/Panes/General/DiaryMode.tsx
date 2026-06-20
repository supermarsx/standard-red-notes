import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import { observer } from 'mobx-react-lite'
import { FunctionComponent, useCallback, useState } from 'react'
import PreferencesGroup from '../../PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '../../PreferencesComponents/PreferencesSegment'
import Switch from '@/Components/Switch/Switch'
import { formatPromptTime, parsePromptTime } from '@/Diary/diary'
import { getDiarySettings, setDiarySettings } from '@/Diary/diaryService'
import { requestNotificationPermission } from '@/Reminders/notificationService'

type Props = {
  application: WebApplication
}

/**
 * Standard Red Notes: Diary mode settings.
 *
 * A small, self-contained section in General preferences. Persists to the app
 * storage K/V (via `getDiarySettings`/`setDiarySettings`), NOT to the published
 * `PrefKey` enum. Enabling it requests OS notification permission from this user
 * gesture (per browser policy); denial is fine — the daily prompt degrades to an
 * in-app toast and the command-palette entry still works.
 */
const DiaryMode: FunctionComponent<Props> = ({ application }: Props) => {
  const [settings, setSettings] = useState(() => getDiarySettings(application))

  const persist = useCallback(
    (next: typeof settings) => {
      setSettings(next)
      setDiarySettings(application, next)
    },
    [application],
  )

  const toggleEnabled = useCallback(() => {
    const enabled = !settings.enabled
    if (enabled) {
      // Request permission from this user gesture; denial degrades to toast-only.
      void requestNotificationPermission()
    }
    persist({ ...settings, enabled })
  }, [settings, persist])

  const onTimeChange = useCallback(
    (value: string) => {
      const parsed = parsePromptTime(value)
      if (!parsed) {
        return
      }
      persist({ ...settings, hour: parsed.hour, minute: parsed.minute })
    },
    [settings, persist],
  )

  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <div className="flex items-center justify-between">
          <Title>Diary mode</Title>
          <Switch onChange={toggleEnabled} checked={settings.enabled} />
        </div>

        <Subtitle>A once-a-day nudge to write your diary entry</Subtitle>

        <Text className="mt-2">
          When enabled, you'll be reminded once each day to write that day's diary entry. Clicking the reminder
          creates or opens today's entry (filed under a "Diary" tag). You can also open today's entry anytime from the
          command palette via "Open today's diary entry".
        </Text>

        {settings.enabled && (
          <div className="mt-3 flex items-center gap-2">
            <label htmlFor="diary-prompt-time" className="text-sm font-medium">
              Remind me at
            </label>
            <input
              id="diary-prompt-time"
              type="time"
              className="rounded border border-border bg-default px-2 py-1 text-sm"
              value={formatPromptTime(settings.hour, settings.minute)}
              onChange={(event) => onTimeChange(event.target.value)}
            />
          </div>
        )}
      </PreferencesSegment>
    </PreferencesGroup>
  )
}

export default observer(DiaryMode)
