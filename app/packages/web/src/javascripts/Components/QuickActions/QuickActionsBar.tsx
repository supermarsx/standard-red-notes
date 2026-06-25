import { WebApplication } from '@/Application/WebApplication'
import Icon from '@/Components/Icon/Icon'
import Popover from '@/Components/Popover/Popover'
import StyledTooltip from '@/Components/StyledTooltip/StyledTooltip'
import { VectorIconNameOrEmoji } from '@standardnotes/snjs'
import { classNames } from '@standardnotes/utils'
import { useCallback, useEffect, useRef, useState } from 'react'
import QuickActionsConfig from './QuickActionsConfig'
import { loadQuickActions, QuickAction, saveQuickActions } from './quickActionsStorage'
import { defaultIconForAction, defaultLabelForAction, runQuickAction } from './runQuickAction'

type Props = {
  application: WebApplication
}

const QuickActionsBar = ({ application }: Props) => {
  const [actions, setActions] = useState<QuickAction[]>(() => loadQuickActions())
  const [showConfig, setShowConfig] = useState(false)
  const configButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    saveQuickActions(actions)
  }, [actions])

  const toggleConfig = useCallback(() => setShowConfig((show) => !show), [])

  const handleRun = useCallback(
    (action: QuickAction) => {
      runQuickAction(application, action).catch(console.error)
    },
    [application],
  )

  return (
    <div
      className="flex w-full items-center gap-1 overflow-x-auto border-b border-border bg-default px-3 py-1.5"
      role="toolbar"
      aria-label="Quick actions"
    >
      {actions.length === 0 ? (
        <button
          className="flex items-center gap-1.5 rounded px-1.5 py-1 text-sm text-passive-0 hover:bg-contrast hover:text-text"
          onClick={toggleConfig}
          ref={configButtonRef}
          aria-label="Add a quick action"
        >
          <Icon type="add" size="small" />
          <span>Add a quick action</span>
        </button>
      ) : (
        <>
          {actions.map((action) => {
            const label = action.label || defaultLabelForAction(application, action)
            const icon = (action.icon as VectorIconNameOrEmoji) || (defaultIconForAction(action) as VectorIconNameOrEmoji)
            return (
              <StyledTooltip key={action.id} label={label} showOnHover showOnMobile>
                <button
                  className={classNames(
                    'flex flex-shrink-0 items-center gap-1.5 rounded border border-border px-2 py-1',
                    'text-sm text-text hover:bg-contrast',
                  )}
                  onClick={() => handleRun(action)}
                  aria-label={label}
                >
                  <Icon type={icon} size="small" className="flex-shrink-0" />
                  <span className="max-w-[10rem] truncate">{label}</span>
                </button>
              </StyledTooltip>
            )
          })}
          <StyledTooltip label="Configure quick actions" showOnHover side="bottom">
            <button
              className="ml-auto flex flex-shrink-0 items-center rounded p-1 text-passive-0 hover:bg-contrast hover:text-text"
              onClick={toggleConfig}
              ref={configButtonRef}
              aria-label="Configure quick actions"
            >
              <Icon type="tune" size="small" />
            </button>
          </StyledTooltip>
        </>
      )}

      <Popover
        open={showConfig}
        anchorElement={configButtonRef}
        togglePopover={toggleConfig}
        align="end"
        title="Configure quick actions"
        className="py-1"
      >
        <QuickActionsConfig application={application} actions={actions} onChange={setActions} />
      </Popover>
    </div>
  )
}

export default QuickActionsBar
