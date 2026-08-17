import { useCallback, useEffect, useState } from 'react'
import PreferencesGroup from '../Preferences/PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '../Preferences/PreferencesComponents/PreferencesSegment'
import { Title, Subtitle, Text } from '../Preferences/PreferencesComponents/Content'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Switch from '@/Components/Switch/Switch'
import {
  clampMaxRunTime,
  clampMaxSteps,
  clampTemperature,
  clampTopP,
  loadSamplingSettings,
  MAX_STEPS_MAX,
  RunTimeUnit,
  SamplingSettings,
  saveSamplingSettings,
  TEMPERATURE_MAX,
  TEMPERATURE_MIN,
  TOP_P_MAX,
  TOP_P_MIN,
} from '@/Assistant/samplingSettings'

/**
 * Self-contained Preferences section for AGENT RUNTIME limits and the two
 * "use server default" sampling bypasses. Device-local (localStorage) via the
 * sampling settings module — same persistence pattern as the rest of the
 * assistant's web-local settings.
 *
 * Renders:
 *  - Max agent steps (0 = unlimited, not recommended)
 *  - Max run time (number + Minutes/Hours unit, capped at 200 hours)
 *  - Temperature + Top-p sliders, each with a "Use server default" Switch that
 *    greys/disables the slider and makes the client OMIT that parameter.
 *
 * In Server proxy mode generation is controlled by the authenticated backend
 * profile, so the two client sampling overrides are visible but locked.
 */
const AgentRuntimeSettings = ({
  accountScope,
  serverProxy,
}: {
  accountScope: string | undefined
  serverProxy: boolean
}) => {
  const [sampling, setSampling] = useState<SamplingSettings>(() => loadSamplingSettings(accountScope))

  useEffect(() => {
    setSampling(loadSamplingSettings(accountScope))
  }, [accountScope])

  const updateSampling = useCallback(
    (patch: Partial<SamplingSettings>) => {
      setSampling(() => {
        const next = { ...loadSamplingSettings(accountScope), ...patch }
        saveSamplingSettings(accountScope, next)
        return next
      })
    },
    [accountScope],
  )

  const handleUnitChange = useCallback(
    (unit: RunTimeUnit) => {
      setSampling(() => {
        const current = loadSamplingSettings(accountScope)
        const minutes = current.maxRunTimeUnit === 'hours' ? current.maxRunTime * 60 : current.maxRunTime
        const converted = unit === 'hours' ? minutes / 60 : minutes
        const next = { ...current, maxRunTimeUnit: unit, maxRunTime: clampMaxRunTime(converted, unit) }
        saveSamplingSettings(accountScope, next)
        return next
      })
    },
    [accountScope],
  )

  const stepsUnlimited = sampling.maxSteps <= 0

  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <Title>Agent runtime limits</Title>
        <Text>
          Bound how long and how far an assistant run may go, and choose whether to send sampling parameters at all.
          Stored on this device only.
        </Text>

        <HorizontalSeparator classes="my-4" />

        <Subtitle>Max agent steps</Subtitle>
        <Text>
          How many model turns the agent loop may take before it stops and summarizes. Default 16. Up to {MAX_STEPS_MAX}
          . <strong>0 = unlimited (not recommended)</strong>.
        </Text>
        <input
          className="border-border bg-default mt-2 w-28 rounded border px-2 py-1.5 text-sm"
          type="number"
          min={0}
          max={MAX_STEPS_MAX}
          value={sampling.maxSteps}
          onChange={(event) => updateSampling({ maxSteps: clampMaxSteps(Number(event.target.value)) })}
        />
        {stepsUnlimited && (
          <Text className="text-warning mt-1">
            Unlimited steps means a run can loop indefinitely until the time limit or you stop it. Not recommended.
          </Text>
        )}

        <HorizontalSeparator classes="my-4" />

        <Subtitle>Max run time</Subtitle>
        <Text>
          Wall-clock limit for a single agent run. When exceeded, the request and any cancellable tool work stop.
          Default 10 minutes; maximum 200 hours.
        </Text>
        <div className="mt-2 flex items-center gap-2">
          <input
            className="border-border bg-default w-28 rounded border px-2 py-1.5 text-sm"
            type="number"
            min={sampling.maxRunTimeUnit === 'hours' ? 0 : 1}
            max={sampling.maxRunTimeUnit === 'hours' ? 200 : 200 * 60}
            step={sampling.maxRunTimeUnit === 'hours' ? 0.5 : 1}
            value={sampling.maxRunTime}
            onChange={(event) =>
              updateSampling({ maxRunTime: clampMaxRunTime(Number(event.target.value), sampling.maxRunTimeUnit) })
            }
          />
          <select
            className="border-border bg-default rounded border px-2 py-1.5 text-sm"
            value={sampling.maxRunTimeUnit}
            onChange={(event) => handleUnitChange(event.target.value as RunTimeUnit)}
          >
            <option value="minutes">Minutes</option>
            <option value="hours">Hours</option>
          </select>
        </div>

        <HorizontalSeparator classes="my-4" />

        <div className="flex items-center justify-between">
          <div className="mr-4 flex flex-col">
            <Subtitle>
              Temperature:{' '}
              {serverProxy
                ? 'backend profile'
                : sampling.useServerTemperature
                  ? 'provider default'
                  : sampling.temperature.toFixed(2)}
            </Subtitle>
            <Text>
              Higher values make output more random/creative; lower values make it more focused. Range {TEMPERATURE_MIN}
              –{TEMPERATURE_MAX}. In Direct mode, “Use provider default” omits this parameter. Server proxy always uses
              the administrator-assigned backend profile.
            </Text>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <Text className="text-passive-1">Use provider default</Text>
            <Switch
              checked={sampling.useServerTemperature}
              disabled={serverProxy}
              onChange={(value) => updateSampling({ useServerTemperature: value })}
            />
          </div>
        </div>
        <input
          className="mt-2 w-full disabled:opacity-40"
          type="range"
          min={TEMPERATURE_MIN}
          max={TEMPERATURE_MAX}
          step={0.05}
          disabled={serverProxy || sampling.useServerTemperature}
          value={sampling.temperature}
          onChange={(event) => updateSampling({ temperature: clampTemperature(Number(event.target.value)) })}
        />

        <HorizontalSeparator classes="my-4" />

        <div className="flex items-center justify-between">
          <div className="mr-4 flex flex-col">
            <Subtitle>
              Top-p (nucleus sampling):{' '}
              {serverProxy ? 'backend profile' : sampling.useServerTopP ? 'provider default' : sampling.topP.toFixed(2)}
            </Subtitle>
            <Text>
              Limits sampling to the most probable tokens whose cumulative probability reaches this value. Range{' '}
              {TOP_P_MIN}–{TOP_P_MAX}. In Direct mode, “Use provider default” omits this parameter. Server proxy always
              uses the administrator-assigned backend profile.
            </Text>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <Text className="text-passive-1">Use provider default</Text>
            <Switch
              checked={sampling.useServerTopP}
              disabled={serverProxy}
              onChange={(value) => updateSampling({ useServerTopP: value })}
            />
          </div>
        </div>
        <input
          className="mt-2 w-full disabled:opacity-40"
          type="range"
          min={TOP_P_MIN}
          max={TOP_P_MAX}
          step={0.05}
          disabled={serverProxy || sampling.useServerTopP}
          value={sampling.topP}
          onChange={(event) => updateSampling({ topP: clampTopP(Number(event.target.value)) })}
        />
      </PreferencesSegment>
    </PreferencesGroup>
  )
}

export default AgentRuntimeSettings
