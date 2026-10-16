import { FunctionComponent, useMemo } from 'react'
import { classNames } from '@standardnotes/utils'
import { buildMeterModel, formatResetDuration, TokenWindowUsage } from '@/Assistant/usageMeter'
import type { ChatTokenUsage } from '@/Assistant/usageMeterProvider'
import { formatTokens } from '@/Components/Footer/assistantUsageFormat'

type WindowMeterProps = {
  label: string
  window: TokenWindowUsage | undefined
}

/** Inline window status; full counts and reset details remain available on hover and to assistive technology. */
const WindowMeter: FunctionComponent<WindowMeterProps> = ({ label, window }) => {
  const model = useMemo(() => buildMeterModel(window), [window])
  const resetIn = useMemo(() => (window && !window.unavailable ? formatResetDuration(window.resetsAt) : ''), [window])

  const value = model.unavailable ? 'Unavailable' : model.unlimited ? 'Unlimited' : model.percentLabel
  const detail = model.unavailable
    ? `${label}: Usage unavailable`
    : model.unlimited
      ? `${label}: ${model.usedLabel} tokens used / Unlimited`
      : `${label}: ${model.valueLabel} tokens (${model.percentLabel})${resetIn && resetIn !== 'now' ? ` · resets in ${resetIn}` : ''}`
  return (
    <span
      className="inline-flex items-baseline gap-1 whitespace-nowrap"
      role="progressbar"
      aria-label={`${label} AI token usage`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={model.unlimited || model.unavailable ? undefined : model.percent}
      aria-valuetext={detail}
      title={detail}
    >
      <span className="text-passive-1">{label === '5-hour' ? '5h' : label}</span>
      <span className={classNames('font-medium tabular-nums', model.textColorClass)}>{value}</span>
    </span>
  )
}

type Props = {
  fiveHour: TokenWindowUsage | undefined
  weekly: TokenWindowUsage | undefined
  chat?: ChatTokenUsage
  className?: string
}

/**
 * In-chat usage details with a single compact line for account limits.
 */
const AssistantUsageMeter: FunctionComponent<Props> = ({ fiveHour, weekly, chat, className }) => {
  if (!fiveHour && !weekly && !chat) {
    return null
  }
  const count = (value: number | undefined) => (value === undefined ? 'not reported' : formatTokens(value))
  const input = chat?.last?.input
  const limit = chat?.last?.contextLimit
  const percent = input !== undefined && limit ? Math.round((input / limit) * 100) : undefined

  return (
    <div className={classNames('flex min-w-0 flex-col gap-2', className)}>
      {chat && (
        <div
          className="text-passive-1 flex min-w-0 flex-wrap gap-x-3 gap-y-0.5 text-[11px] tabular-nums"
          aria-label="Chat token usage"
        >
          <span title="Provider-reported token counts for the last completed model call, including tool or delegated calls.">
            Last call · In {count(chat.last?.input)} · Out {count(chat.last?.output)}
          </span>
          <span title="Provider-reported totals since this chat panel opened. Missing reports are not counted; these are not billing totals or restored history totals.">
            This open chat · In {count(chat.input)} · Out {count(chat.output)}
            {chat.calls > 0 && ` · ${chat.reportedCalls}/${chat.calls} calls reported`}
          </span>
          <span title="Input tokens sent in the last model call, including system prompt, conversation and tool context. The model window is shown only when the provider reports it; output tokens are separate.">
            Input context · {count(input)}
            {limit
              ? ` / ${formatTokens(limit)}${percent !== undefined ? ` (${percent}%)` : ''}`
              : ' · limit not reported'}
          </span>
          {percent !== undefined && (
            <div
              className="bg-passive-3 h-1 w-full overflow-hidden rounded-full"
              role="progressbar"
              aria-label="Last call input context usage"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.min(100, percent)}
            >
              <div
                className={classNames(
                  'h-full',
                  percent >= 100 ? 'bg-danger' : percent >= 80 ? 'bg-warning' : 'bg-info',
                )}
                style={{ width: `${Math.min(100, percent)}%` }}
              />
            </div>
          )}
        </div>
      )}
      {(fiveHour || weekly) && (
        <div className="flex items-center gap-2 text-[11px] leading-4" role="group" aria-label="AI token limits">
          <WindowMeter label="5-hour" window={fiveHour} />
          <span className="text-passive-2" aria-hidden="true">
            ·
          </span>
          <WindowMeter label="Weekly" window={weekly} />
        </div>
      )}
    </div>
  )
}

export default AssistantUsageMeter
