import { useState } from 'react'
import {
  loadDeepResearchSettings,
  normalizeDeepResearchWebLimits,
  saveDeepResearchSettings,
} from '@/Assistant/deepResearchSettings'

export default function DeepResearchLimitsSetting() {
  const [limits, setLimits] = useState(() => normalizeDeepResearchWebLimits(loadDeepResearchSettings()))
  const update = (key: 'maxSources' | 'timeBudgetMinutes', value: number) => {
    const next = normalizeDeepResearchWebLimits({ ...limits, [key]: value })
    saveDeepResearchSettings({ ...loadDeepResearchSettings(), ...next })
    setLimits(next)
  }
  return (
    <fieldset className="mt-3">
      <legend className="text-sm font-semibold">Deep Research budget</legend>
      <div className="mt-2 flex flex-wrap gap-3 text-sm">
        <label className="flex items-center gap-2">
          Maximum sources
          <input
            aria-label="Deep Research maximum sources"
            type="number"
            min={1}
            max={600}
            value={limits.maxSources}
            onChange={(event) => update('maxSources', Number(event.target.value))}
            className="border-border bg-default w-20 rounded border px-2 py-1"
          />
        </label>
        <label className="flex items-center gap-2">
          Minutes
          <input
            aria-label="Deep Research time budget in minutes"
            type="number"
            min={1}
            max={120}
            value={limits.timeBudgetMinutes}
            onChange={(event) => update('timeBudgetMinutes', Number(event.target.value))}
            className="border-border bg-default w-20 rounded border px-2 py-1"
          />
        </label>
      </div>
      <p className="text-passive-1 mt-2 text-xs">
        Defaults: 600 sources and 90 minutes. Research may finish earlier when evidence is sufficient. Keep the tab
        open; Stop ends the run. These budgets apply to new runs on this browser. Provider usage limits still apply.
      </p>
    </fieldset>
  )
}
