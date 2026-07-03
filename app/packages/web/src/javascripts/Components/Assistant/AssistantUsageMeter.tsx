import { FunctionComponent, useMemo } from 'react'
import { classNames } from '@standardnotes/utils'
import { buildMeterModel, formatResetDuration, TokenWindowUsage } from '@/Assistant/usageMeter'

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
  const resetIn = useMemo(
    () => (window && !window.unavailable ? formatResetDuration(window.resetsAt) : ''),
    [window],
  )

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-passive-1">{label}</span>
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
        className="h-1.5 w-full overflow-hidden rounded-full bg-passive-3"
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
      <div className="flex items-center justify-between gap-2 text-[0.65rem] text-passive-1">
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
  className?: string
}

/**
 * The in-chat AI token-usage strip: two side-by-side rolling-window meters (5h +
 * weekly). Non-intrusive — meant for a thin footer/header strip in the assistant
 * panel. Renders nothing when neither window is available (e.g. direct mode).
 */
const AssistantUsageMeter: FunctionComponent<Props> = ({ fiveHour, weekly, className }) => {
  if (!fiveHour && !weekly) {
    return null
  }

  return (
    <div className={classNames('flex items-stretch gap-4', className)}>
      <WindowMeter label="5-hour" window={fiveHour} />
      <WindowMeter label="Weekly" window={weekly} />
    </div>
  )
}

export default AssistantUsageMeter
