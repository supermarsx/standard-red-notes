import { WebApplication } from '@/Application/WebApplication'
import { classNames } from '@standardnotes/snjs'
import { FunctionComponent, memo } from 'react'
import { useAssistantUsage } from '@/Hooks/useAssistantUsage'
import { buildChipModel, capFraction, formatTokens, isAtLimit } from './assistantUsageFormat'

type Props = {
  application: WebApplication
}

const AssistantUsage: FunctionComponent<Props> = ({ application }) => {
  const { session, cap } = useAssistantUsage(application)
  const chip = buildChipModel(session.totalTokens, session.requests, cap)

  if (!chip.visible) {
    return null
  }

  // Tooltip: honest about provenance + a per-figure breakdown.
  const lines: string[] = []
  if (cap && cap.limit > 0) {
    const fraction = capFraction(cap)
    const pct = fraction !== undefined ? ` (${Math.round(fraction * 100)}%)` : ''
    lines.push(`Server daily request cap: ${cap.used} / ${cap.limit} requests used today${pct}.`)
    if (isAtLimit(cap)) {
      lines.push('Daily request limit reached — assistant requests will be refused until it resets.')
    }
  }
  lines.push(`Session requests: ${session.requests.toLocaleString()}`)
  if (session.totalTokens > 0) {
    lines.push(
      `Session tokens: ${session.totalTokens.toLocaleString()} ` +
        `(${session.promptTokens.toLocaleString()} prompt + ${session.completionTokens.toLocaleString()} completion)`,
    )
  }
  if (session.requests > 0 && session.requestsWithTokens < session.requests) {
    lines.push(
      `${session.requests - session.requestsWithTokens} of this session's requests reported no token usage.`,
    )
  }
  lines.push('Token counts come from the AI provider and are approximate.')
  const tooltip = lines.join('\n')

  const colorClass = chip.warn ? (isAtLimit(cap) ? 'text-danger' : 'text-warning') : 'text-neutral'

  return (
    <div
      title={tooltip}
      className={classNames('flex select-none items-center whitespace-nowrap text-xs font-bold', colorClass)}
      role="status"
      aria-label={`AI usage — ${chip.label.replace(/^AI:\s*/, '')}`}
    >
      {/* Narrow widths: just the short label. Wider widths: append a token hint
          when a cap is the primary figure so both are visible. */}
      <span>{chip.label}</span>
      {cap && cap.limit > 0 && session.totalTokens > 0 && (
        <span className="ml-1 hidden font-normal opacity-70 lg:inline">· {formatTokens(session.totalTokens)} tok</span>
      )}
    </div>
  )
}

/**
 * Memoized so the chip only re-renders when its inputs change — the usage hook
 * already de-dupes session totals and the server cap, so unrelated footer state
 * (sync messages, etc.) does not re-render it. Mirrors ConnectionStatus.
 */
export default memo(AssistantUsage)
