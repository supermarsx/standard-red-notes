import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import { FunctionComponent, useCallback, useMemo, useState } from 'react'
import PreferencesGroup from '../../PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '../../PreferencesComponents/PreferencesSegment'
import { getTimeZoneSettings, setTimeZoneSettings } from '@/Timezone/timezoneService'
import {
  getConfiguredTimeZone,
  getSupportedTimeZones,
  getSystemTimeZone,
  timeZoneDisplayLabel,
} from '@/Timezone/timezone'

type Props = {
  application: WebApplication
}

/**
 * Standard Red Notes: preferred timezone setting.
 *
 * A small, self-contained section in General preferences. Persists to the app
 * storage K/V (via `getTimeZoneSettings`/`setTimeZoneSettings`), NOT to the
 * published `PrefKey` enum. The empty value ("") means "follow the system zone",
 * so the setting tracks OS changes. New clock widgets default to this zone.
 */
const TimezonePreference: FunctionComponent<Props> = ({ application }: Props) => {
  const [settings, setSettings] = useState(() => getTimeZoneSettings(application))

  const zones = useMemo(() => getSupportedTimeZones(), [])
  const systemZone = useMemo(() => getSystemTimeZone(), [])
  const resolvedZone = getConfiguredTimeZone(settings)

  const onChange = useCallback(
    (value: string) => {
      const next = { timeZone: value }
      setSettings(next)
      setTimeZoneSettings(application, next)
    },
    [application],
  )

  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <Title>Timezone</Title>
        <Subtitle>Your preferred timezone</Subtitle>
        <Text className="mt-2">
          Choose the timezone used by date/time widgets such as the clock block. Leave it on "Follow system" to track
          your device's timezone automatically.
        </Text>

        <div className="mt-3 flex flex-col gap-1">
          <label htmlFor="timezone-preference-select" className="text-sm font-medium">
            Timezone
          </label>
          <select
            id="timezone-preference-select"
            className="rounded border border-border bg-default px-2 py-1 text-sm text-foreground"
            value={settings.timeZone}
            onChange={(event) => onChange(event.target.value)}
          >
            <option value="">Follow system ({timeZoneDisplayLabel(systemZone)})</option>
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {timeZoneDisplayLabel(zone)}
              </option>
            ))}
          </select>
          <Text className="mt-1">Currently using: {timeZoneDisplayLabel(resolvedZone)}</Text>
        </div>
      </PreferencesSegment>
    </PreferencesGroup>
  )
}

export default TimezonePreference
