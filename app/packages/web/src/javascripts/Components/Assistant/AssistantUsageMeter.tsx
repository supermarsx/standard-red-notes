import { FunctionComponent, useMemo } from 'react'
import { classNames } from '@standardnotes/utils'
import { buildMeterModel, formatResetDuration, TokenWindowUsage } from '@/Assistant/usageMeter'
import type { ChatTokenUsage } from '@/Assistant/usageMeterProvider'
import { formatTokens } from '@/Components/Footer/assistantUsageFormat'

type WindowMeterProps = {
  label: string
  window: TokenWindowUsage | undefined
}

/**
 * One compact horizontal token meter: a themed progress bar coloured by headroom
 * (green -> amber near the cap -> red at/over it), with the used/limit token
 * counts and the rolling-window reset time. Renders "Unlimited" when no cap is
 * configured and a muted state when the server couldn't read usage (fail-open).
 */
const WindowMeter: FunctionComponent<WindowMeterProps> = ({ label, window }) => {
  const model = useMemo(() => buildMeterModel(window), [window])
  const resetIn = useMemo(() => (window && !window.unavailable ? formatResetDuration(window.resetsAt) : ''), [window])

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-passive-1 text-xs font-semibold tracking-wide uppercase">{label}</span>
        <span className={classNames('text-xs tabular-nums', model.textColorClass)}>
          {model.unlimited ? (
            <>
              {model.usedLabel} <span className="text-passive-1">/ Unlimited</span>
            </>
          ) : (
            model.valueLabel
          )}
        </span>
      </div>
      <div
        className="bg-passive-3 h-1.5 w-full overflow-hidden rounded-full"
        role="progressbar"
        aria-label={`${label} AI token usage`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={model.unlimited || model.unavailable ? undefined : model.percent}
      >
        {!model.unlimited && !model.unavailable && (
          <div
            className={classNames('h-full rounded-full transition-all', model.barColorClass)}
            style={{ width: `${Math.max(2, model.percent)}%` }}
          />
        )}
      </div>
      <div className="text-passive-1 flex items-center justify-between gap-2 text-[0.65rem]">
        {model.unavailable ? (
          <span>Usage unavailable</span>
        ) : model.unlimited ? (
          <span>No token cap</span>
        ) : (
          <>
            <span className={model.textColorClass}>{model.percentLabel}</span>
            {resetIn && resetIn !== 'now' && <span title={window?.resetsAt}>resets in {resetIn}</span>}
          </>
        )}
      </div>
    </div>
  )
}

type Props = {
  fiveHour: TokenWindowUsage | undefined
  weekly: TokenWindowUsage | undefined
  chat?: ChatTokenUsage
  className?: string
}

/**
 * The in-chat AI token-usage strip: two side-by-side rolling-window meters (5h +
 * weekly). Non-intrusive — meant for a thin footer/header strip in the assistant
 * panel. Renders nothing when neither window is available (e.g. direct mode).
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
        <div className="flex items-stretch gap-4">
          <WindowMeter label="5-hour" window={fiveHour} />
          <WindowMeter label="Weekly" window={weekly} />
        </div>
      )}
    </div>
  )
}

export default AssistantUsageMeter
