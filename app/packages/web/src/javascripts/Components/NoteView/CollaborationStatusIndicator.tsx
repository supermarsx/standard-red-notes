import { FunctionComponent, useCallback, useEffect, useRef, useState } from 'react'
import { classNames } from '@standardnotes/utils'
import { IconType } from '@standardnotes/snjs'
import Icon from '../Icon/Icon'
import Popover from '../Popover/Popover'
import { usePresence } from '../SuperEditor/Collaboration/usePresence'
import { useCollaborationStatus } from '../SuperEditor/Collaboration/useCollaborationStatus'
import { CollaborationRoomState } from '../SuperEditor/Collaboration/CollaborationStatusRegistry'
import { PresentPeer } from '../SuperEditor/Collaboration/PresenceRegistry'
import { collaboratorColor, collaboratorInitials } from '../SuperEditor/Collaboration/collaboratorColor'

/**
 * How long a first-time "preparing" must last before it is worth a pixel.
 *
 * Encrypted room preparation runs on every Super note open. On a deployment
 * where the collaboration gateway is not reachable it starts and fails within a
 * few hundred milliseconds, every single time. Rendering that would be exactly
 * the flicker the status row must not have, and the user learns nothing from it
 * because the editor is fully usable throughout. A room that has ALREADY been
 * live is different: dropping back to preparing means "reconnecting", which is
 * real information, so that case is shown immediately.
 */
export const PREPARING_QUIET_PERIOD_MS = 750

export const COLLABORATION_INDICATOR_TEST_ID = 'collaboration-status-indicator'

type Props = {
  /** The note whose collaboration room this indicator reflects. */
  noteUuid: string
}

type Presentation = {
  icon: IconType
  chipClassName: string
  animateIcon: boolean
  /** Accessible name — MUST describe the current state, not the widget. */
  label: string
  heading: string
  detail?: string
}

function describePeers(peers: PresentPeer[]): string {
  return peers.map((peer) => peer.name).join(', ')
}

function presentationFor(state: CollaborationRoomState, peers: PresentPeer[]): Presentation {
  if (state.status.kind === 'active') {
    const heading = 'Encrypted collaboration active'
    if (peers.length === 0) {
      return {
        icon: 'user',
        chipClassName: 'bg-success text-success-contrast',
        animateIcon: false,
        label: 'Encrypted collaboration active. No one else is editing this note right now.',
        heading,
        detail: 'End-to-end encrypted live editing is on. No one else is editing this note right now.',
      }
    }
    const names = describePeers(peers)
    const noun = peers.length === 1 ? 'collaborator' : 'collaborators'
    return {
      icon: 'user-filled',
      chipClassName: 'bg-success text-success-contrast',
      animateIcon: false,
      label: `Encrypted collaboration active. ${peers.length} ${noun} editing now: ${names}`,
      heading,
      detail: `${peers.length} ${noun} editing now.`,
    }
  }

  if (state.status.kind === 'preparing') {
    return state.hasBeenActive
      ? {
          icon: 'sync',
          chipClassName: 'bg-warning text-warning-contrast',
          animateIcon: true,
          label: 'Reconnecting encrypted collaboration. Your edits are still being saved.',
          heading: 'Reconnecting encrypted collaboration',
          detail: 'Live editing dropped and is reconnecting. Your edits are still saved as usual meanwhile.',
        }
      : {
          icon: 'sync',
          chipClassName: 'bg-contrast text-passive-1',
          animateIcon: true,
          label: 'Preparing encrypted collaboration. You can keep editing.',
          heading: 'Preparing encrypted collaboration',
          detail: 'Setting up the end-to-end encrypted room. You can keep editing while this finishes.',
        }
  }

  return {
    icon: 'cloud-off',
    chipClassName: 'bg-warning text-warning-contrast',
    animateIcon: false,
    label: `Encrypted collaboration unavailable. ${state.status.reason}`,
    heading: 'Encrypted collaboration unavailable',
    detail: state.status.reason,
  }
}

/**
 * Compact collaboration status chip, rendered immediately BEFORE the note sync
 * status in the title bar and deliberately built to the same idiom (a 20px round
 * chip that toggles a Popover).
 *
 * It replaces the former full-editor takeover: collaboration state must never
 * cover, dim or disable the editing surface, so everything the takeover said now
 * lives here, in a row the user can ignore.
 *
 * It renders NOTHING unless collaboration is genuinely applicable and worth
 * reporting:
 *  - no entry in the registry (plain/component editor, no Super editor) -> hidden
 *  - unavailable and never once live -> hidden, because "this deployment has no
 *    live collaboration" is not news on every note open
 *  - preparing for the first time -> hidden until PREPARING_QUIET_PERIOD_MS
 * so the common quiet path really is silent rather than a permanent dead icon.
 */
const CollaborationStatusIndicator: FunctionComponent<Props> = ({ noteUuid }) => {
  const state = useCollaborationStatus(noteUuid)
  const { peers } = usePresence(noteUuid)
  const [isTooltipVisible, setIsTooltipVisible] = useState(false)
  const [quietPeriodElapsed, setQuietPeriodElapsed] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const isFirstPreparation = state?.status.kind === 'preparing' && !state.hasBeenActive

  useEffect(() => {
    if (!isFirstPreparation) {
      setQuietPeriodElapsed(false)
      return
    }
    const timer = setTimeout(() => setQuietPeriodElapsed(true), PREPARING_QUIET_PERIOD_MS)
    return () => clearTimeout(timer)
  }, [isFirstPreparation])

  const toggleTooltip = useCallback(() => {
    setIsTooltipVisible((visible) => !visible)
  }, [])

  if (!state) {
    return null
  }
  if (state.status.kind === 'unavailable' && !state.hasBeenActive) {
    return null
  }
  if (isFirstPreparation && !quietPeriodElapsed) {
    return null
  }

  const presentation = presentationFor(state, peers)

  return (
    <div className="note-status-tooltip-container mr-2">
      <button
        aria-label={presentation.label}
        className={classNames(
          'peer flex h-5 w-5 flex-shrink-0 cursor-pointer items-center justify-center rounded-full',
          presentation.chipClassName,
        )}
        data-testid={COLLABORATION_INDICATOR_TEST_ID}
        onClick={toggleTooltip}
        ref={buttonRef}
        title={presentation.label}
        type="button"
      >
        <Icon className={presentation.animateIcon ? 'animate-spin' : ''} type={presentation.icon} size="small" />
      </button>
      <Popover
        title="Encrypted collaboration status"
        open={isTooltipVisible}
        togglePopover={() => setIsTooltipVisible((visible) => !visible)}
        className="px-3 py-2"
        containerClassName="!min-w-0 !w-auto max-w-[90vw]"
        anchorElement={buttonRef}
        side="bottom"
        align="center"
        offset={6}
        disableMobileFullscreenTakeover
        disableApplyingMobileWidth
      >
        <div className="text-sm font-bold">{presentation.heading}</div>
        {presentation.detail && <div className="mt-0.5 text-sm">{presentation.detail}</div>}
        {peers.length > 0 && (
          <div className="mt-1.5 space-y-1">
            {peers.map((peer) => (
              <div key={peer.userUuid || peer.clientId} className="flex items-center gap-2">
                <div
                  className="flex h-5 w-5 items-center justify-center rounded-full text-[0.55rem] font-bold text-white select-none"
                  style={{ backgroundColor: peer.color || collaboratorColor(peer.userUuid || String(peer.clientId)) }}
                  aria-hidden
                >
                  {collaboratorInitials(peer.name)}
                </div>
                <span className="text-text truncate text-sm">{peer.name}</span>
              </div>
            ))}
          </div>
        )}
      </Popover>
    </div>
  )
}

export default CollaborationStatusIndicator
