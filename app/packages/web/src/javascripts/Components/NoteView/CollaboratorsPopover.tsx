import { forwardRef } from 'react'
import { classNames } from '@standardnotes/utils'
import Button from '../Button/Button'
import Icon from '../Icon/Icon'
import { CollaboratorAvatar } from './CollaboratorAvatars'
import {
  Collaborator,
  CollaboratorPresence,
  presenceLabel,
  roleLabel,
  SessionPresentation,
  SessionTone,
  unknownMemberExplanation,
  unknownPresenceReason,
} from './collaborators'

/** The status chip's colours, shared by the trigger and the popup's own heading. */
export const SESSION_TONE_CLASS: Record<SessionTone, string> = {
  live: 'bg-success text-success-contrast',
  busy: 'bg-contrast text-passive-1',
  warning: 'bg-warning text-warning-contrast',
  quiet: 'bg-contrast text-passive-1',
}

const PRESENCE_CLASS: Record<CollaboratorPresence, string> = {
  typing: 'text-success',
  editing: 'text-success',
  viewing: 'text-success',
  here: 'text-success',
  idle: 'text-passive-1',
  reconnecting: 'text-warning',
  away: 'text-passive-1',
  unknown: 'text-passive-1',
}

type Props = {
  id: string
  session: SessionPresentation
  /** Who is here, in a sentence. Shown only when there is no list to say it. */
  attendance: string
  collaborators: Collaborator[]
  collapsed: boolean
  /** Absent where it would change nothing: nobody to collapse, or a bar that already shows the count. */
  onToggleCollapsed?: () => void
  /** Keyboard focus has stepped past either end of the popup. */
  onLeave: () => void
}

/**
 * Catches Tab at an end of the popup. The popup is portalled to the end of the
 * document, so the element "after" it is whatever happens to follow a portal;
 * landing here instead lets the owner close the popup and put focus back on the
 * trigger. A guard rather than a keydown handler, because what is tabbable
 * inside is not ours to enumerate — a list long enough to scroll is a tab stop
 * of the browser's own making.
 */
const FocusGuard = ({ onFocus }: { onFocus: () => void }) => (
  <span
    aria-hidden
    className="pointer-events-none absolute h-px w-px overflow-hidden opacity-0"
    data-collaborators-focus-guard
    onFocus={onFocus}
    tabIndex={0}
  />
)

/**
 * Everything there is to know about a note's collaboration, in one place: what
 * the session is doing, then every person and what they are doing.
 *
 * Presentational only — it is handed finished data, so every state it can show
 * can be rendered without a live room.
 */
const CollaboratorsPopover = forwardRef<HTMLDivElement, Props>(
  ({ id, session, attendance, collaborators, collapsed, onToggleCollapsed, onLeave }, ref) => {
    return (
      <>
        <FocusGuard onFocus={onLeave} />
        <div
          aria-label="Collaborators"
          className="w-72 max-w-full outline-none"
          id={id}
          ref={ref}
          role="dialog"
          tabIndex={-1}
        >
          <div className="flex items-start gap-2" data-collaboration-session={session.tone}>
            <span
              aria-hidden
              className={classNames(
                'mt-px flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full',
                SESSION_TONE_CLASS[session.tone],
              )}
            >
              <Icon className={session.animateIcon ? 'animate-spin' : ''} type={session.icon} size="small" />
            </span>
            <div className="min-w-0">
              <div className="text-sm font-bold">{session.heading}</div>
              <div className="text-passive-0 text-xs">{session.detail}</div>
              {attendance && collaborators.length === 0 && (
                <div className="text-passive-0 text-xs" data-collaboration-attendance>
                  {attendance}
                </div>
              )}
            </div>
          </div>
          {collaborators.length > 0 && (
            <ul
              aria-label="People with access to this note"
              className="border-border mt-2 max-h-72 space-y-1 overflow-y-auto border-t pt-2"
              data-collaborator-list
            >
              {collaborators.map((collaborator) => {
                const status = collaborator.isSelf
                  ? collaborator.openElsewhere
                    ? 'Also open in another tab or device'
                    : undefined
                  : presenceLabel(collaborator.presence)
                return (
                  <li
                    className="flex items-center gap-2"
                    data-collaborator={collaborator.key}
                    data-presence={collaborator.isSelf ? 'self' : collaborator.presence}
                    key={collaborator.key}
                  >
                    <CollaboratorAvatar
                      className={collaborator.isPresent || collaborator.isSelf ? undefined : 'opacity-50'}
                      collaborator={collaborator}
                      size="list"
                    />
                    <div className="min-w-0 flex-1">
                      <div
                        className="text-text truncate text-sm leading-4 font-medium"
                        data-collaborator-name
                        title={
                          collaborator.accountId ? unknownMemberExplanation(collaborator.accountId) : collaborator.name
                        }
                      >
                        {collaborator.name}
                        {collaborator.accountId && (
                          // Enough of the id to tell two such people apart, and to find them among the
                          // vault's members, where there is no hover to show the whole of it.
                          <span className="text-passive-1 font-normal" data-collaborator-account>
                            {' '}
                            {collaborator.accountId.slice(0, 8)}
                          </span>
                        )}
                      </div>
                      <div className="text-passive-1 flex flex-wrap gap-x-1 text-xs leading-4">
                        {status && (
                          <span
                            className={collaborator.isSelf ? undefined : PRESENCE_CLASS[collaborator.presence]}
                            data-collaborator-status
                            title={
                              !collaborator.isSelf && collaborator.presence === 'unknown'
                                ? unknownPresenceReason(collaborator)
                                : undefined
                            }
                          >
                            {status}
                          </span>
                        )}
                        {status && collaborator.role && <span aria-hidden>·</span>}
                        {collaborator.role && <span data-collaborator-role>{roleLabel(collaborator.role)}</span>}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
          {onToggleCollapsed && (
            <Button className="mt-2" data-collaborators-collapse onClick={onToggleCollapsed} small>
              {collapsed ? 'Show avatars in the title bar' : 'Collapse to a count'}
            </Button>
          )}
        </div>
        <FocusGuard onFocus={onLeave} />
      </>
    )
  },
)

CollaboratorsPopover.displayName = 'CollaboratorsPopover'

export default CollaboratorsPopover
