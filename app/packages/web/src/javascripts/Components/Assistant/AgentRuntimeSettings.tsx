import { useCallback, useState } from 'react'
import { WebApplication } from '@/Application/WebApplication'
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
 * Takes `application` so it can sit alongside the other assistant settings panes
 * (it does not currently read from it, but keeps a consistent signature and
 * leaves room for application-scoped behavior).
 */
const AgentRuntimeSettings = ({ application: _application }: { application: WebApplication }) => {
  const [sampling, setSampling] = useState<SamplingSettings>(() => loadSamplingSettings())

  const updateSampling = useCallback((patch: Partial<SamplingSettings>) => {
    setSampling((prev) => {
      const next = { ...prev, ...patch }
      saveSamplingSettings(next)
      return next
    })
  }, [])

  const handleUnitChange = useCallback(
    (unit: RunTimeUnit) => {
      setSampling((prev) => {
        // Re-clamp the existing value under the new unit so it stays in [1min, 200h].
        const next = { ...prev, maxRunTimeUnit: unit, maxRunTime: clampMaxRunTime(prev.maxRunTime, unit) }
        saveSamplingSettings(next)
        return next
      })
    },
    [],
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
          How many model turns the agent loop may take before it stops and summarizes. Default 500. Up to{' '}
          {MAX_STEPS_MAX}. <strong>0 = unlimited (not recommended)</strong>.
        </Text>
        <input
          className="mt-2 w-28 rounded border border-border bg-default px-2 py-1.5 text-sm"
          type="number"
          min={0}
          max={MAX_STEPS_MAX}
          value={sampling.maxSteps}
          onChange={(event) => updateSampling({ maxSteps: clampMaxSteps(Number(event.target.value)) })}
        />
        {stepsUnlimited && (
          <Text className="mt-1 text-warning">
            Unlimited steps means a run can loop indefinitely until the time limit or you stop it. Not recommended.
          </Text>
        )}

        <HorizontalSeparator classes="my-4" />

        <Subtitle>Max run time</Subtitle>
        <Text>
          Wall-clock limit for a single agent run. When exceeded the run stops gracefully and summarizes what it has.
          Default 200 hours (also the maximum).
        </Text>
        <div className="mt-2 flex items-center gap-2">
          <input
            className="w-28 rounded border border-border bg-default px-2 py-1.5 text-sm"
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
            className="rounded border border-border bg-default px-2 py-1.5 text-sm"
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
            <Subtitle>Temperature: {sampling.useServerTemperature ? 'server default' : sampling.temperature.toFixed(2)}</Subtitle>
            <Text>
              Higher values make output more random/creative; lower values make it more focused. Range {TEMPERATURE_MIN}–
              {TEMPERATURE_MAX}. Turn on “Use server default” to omit this parameter entirely so the provider/server picks
              its own.
            </Text>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <Text className="text-passive-1">Use server default</Text>
            <Switch
              checked={sampling.useServerTemperature}
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
          disabled={sampling.useServerTemperature}
          value={sampling.temperature}
          onChange={(event) => updateSampling({ temperature: clampTemperature(Number(event.target.value)) })}
        />

        <HorizontalSeparator classes="my-4" />

        <div className="flex items-center justify-between">
          <div className="mr-4 flex flex-col">
            <Subtitle>Top-p (nucleus sampling): {sampling.useServerTopP ? 'server default' : sampling.topP.toFixed(2)}</Subtitle>
            <Text>
              Limits sampling to the most probable tokens whose cumulative probability reaches this value. Range{' '}
              {TOP_P_MIN}–{TOP_P_MAX}. Turn on “Use server default” to omit this parameter entirely so the provider/server
              picks its own.
            </Text>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <Text className="text-passive-1">Use server default</Text>
            <Switch checked={sampling.useServerTopP} onChange={(value) => updateSampling({ useServerTopP: value })} />
          </div>
        </div>
        <input
          className="mt-2 w-full disabled:opacity-40"
          type="range"
          min={TOP_P_MIN}
          max={TOP_P_MAX}
          step={0.05}
          disabled={sampling.useServerTopP}
          value={sampling.topP}
          onChange={(event) => updateSampling({ topP: clampTopP(Number(event.target.value)) })}
        />
      </PreferencesSegment>
    </PreferencesGroup>
  )
}

export default AgentRuntimeSettings
