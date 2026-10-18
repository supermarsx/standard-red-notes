import { useState, type ReactNode } from 'react'
import Icon from '@/Components/Icon/Icon'
import type { AssistantActivityOmittedCounts } from '@/Assistant/assistantChatHistory'

export type AssistantActivitySummary = {
  label: string
  outcome?: 'succeeded' | 'failed' | 'denied' | 'interrupted'
  changed?: boolean
}

/** Display observed tool activity only; detailed cards remain owned by the caller. */
export default function AssistantActivityGroup({
  tools,
  children,
  streaming = false,
  omittedCounts,
}: {
  tools: readonly AssistantActivitySummary[]
  children: ReactNode
  streaming?: boolean
  omittedCounts?: AssistantActivityOmittedCounts
}) {
  const [expanded, setExpanded] = useState(false)
  if (!tools.length && !Object.values(omittedCounts ?? {}).some((count) => count > 0)) {
    return null
  }
  const pending = tools.filter((tool) => tool.outcome === undefined).at(-1)
  const succeeded = tools.filter((tool) => tool.outcome === 'succeeded').length + (omittedCounts?.succeeded ?? 0)
  const changed = tools.filter((tool) => tool.changed && tool.outcome === 'succeeded').length
  const issues = (['failed', 'denied', 'interrupted'] as const)
    .map((outcome) => ({
      outcome,
      count: tools.filter((tool) => tool.outcome === outcome).length + (omittedCounts?.[outcome] ?? 0),
    }))
    .filter(({ count }) => count > 0)
  return (
    <details className="group/activity min-w-0 text-xs" onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary className="text-passive-1 hover:text-text focus-visible:ring-info flex min-w-0 cursor-pointer list-none flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded py-1 leading-4 outline-none select-none focus-visible:ring-2 [&::-webkit-details-marker]:hidden">
        <Icon
          type="chevron-right"
          size="small"
          className="shrink-0 transition-transform group-open/activity:rotate-90"
        />
        <span className="min-w-0 truncate" title={pending?.label}>
          {pending ? pending.label : `${succeeded} completed`}
        </span>
        {(pending || streaming) && (
          <span className="shrink-0" aria-label={streaming ? 'Generating response' : undefined}>
            · Working…
          </span>
        )}
        {pending && succeeded > 0 && <span className="shrink-0">· {succeeded} completed</span>}
        {issues.map(({ outcome, count }) => (
          <span key={outcome} className={outcome === 'interrupted' ? 'shrink-0' : 'text-danger shrink-0'}>
            · {count} {outcome}
          </span>
        ))}
        {changed > 0 && <span className="shrink-0">· {changed} changed</span>}
      </summary>
      {expanded && (
        <div className="mt-1 flex max-h-80 min-w-0 flex-col gap-1 overflow-y-auto">
          {Object.values(omittedCounts ?? {}).some((count) => count > 0) && (
            <p className="text-passive-1">Counts include earlier actions. Only recent action details are retained.</p>
          )}
          {children}
        </div>
      )}
    </details>
  )
}
