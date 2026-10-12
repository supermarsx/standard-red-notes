import { FunctionComponent, KeyboardEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { classNames } from '@standardnotes/utils'
import { SNNote } from '@standardnotes/snjs'
import { MediaQueryBreakpoints, useMediaQuery } from '@/Hooks/useMediaQuery'
import { useLocalPreference } from '@/Hooks/usePreference'
import Icon from '../Icon/Icon'
import Popover from '../Popover/Popover'
import { usePresence } from '../SuperEditor/Collaboration/usePresence'
import { useCollaborationStatus } from '../SuperEditor/Collaboration/useCollaborationStatus'
import { CollaboratorAvatarStack } from './CollaboratorAvatars'
import CollaboratorsPopover, { SESSION_TONE_CLASS } from './CollaboratorsPopover'
import {
  buildCollaborators,
  COLLABORATORS_COLLAPSED_PREF_KEY,
  describeAttendance,
  describeSession,
  FirstPreparationPhase,
  normalizeCollaboratorsCollapsed,
  PRESENCE_CLOCK_TICK_MS,
  presenceNeedsClock,
  rememberBroadcastNames,
  sessionSpeaksForItself,
  trackFirstSeen,
} from './collaborators'
import { useVaultRoster } from './useVaultRoster'

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

/**
 * When a first-time "preparing" stops being worth a pixel again.
 *
 * A preparation that has run this long on a room that has never been live is
 * indistinguishable from "this deployment does not offer live collaboration" —
 * and it can genuinely never resolve, e.g. when the gateway answers the sync
 * ticket with 503 SYNC_DISABLED. A spinner that never stops is worse than no
 * spinner: it promises progress that is not happening and then sits in the
 * status bar forever. So it stands down and goes quiet instead.
 *
 * A room that HAS been live never stands down — "reconnecting" stays visible
 * for as long as it is true, because there the user really did lose something.
 */
export const PREPARING_STAND_DOWN_MS = 20_000

export const COLLABORATION_INDICATOR_TEST_ID = 'collaboration-status-indicator'

/** How long to keep trying to move focus into a popup that is still being positioned. */
const FOCUS_ATTEMPT_FRAMES = 30

/**
 * The popup's padding, and its own opaque background in place of Popover's
 * translucent one. Both overrides are `!important` because Popover sets the same
 * two properties with classes of its own on the same element, and which of two
 * equal utilities wins is decided by the stylesheet's order, not by this file.
 */
export const POPUP_SURFACE_CLASS = 'px-3 py-2 md:!bg-default ![backdrop-filter:none]'

type Props = {
  /** The note whose collaboration room and shared vault this reflects. */
  note: SNNote
}

/**
 * Collaboration in the title bar, in one control: the session's status chip and,
 * beside it, whoever else is in the note right now. It sits immediately BEFORE
 * the note sync status and is built to the same idiom — a 20px round chip that
 * opens a Popover — so the row reads as one row and never grows.
 *
 * The chip is the whole of it when nobody else is here. With collaborators it
 * grows sideways only: up to MAX_BAR_AVATARS overlapping avatars in their cursor
 * colours and "+N" for the rest, or — collapsed by choice, and always below `md`
 * — just the count inside the chip. Clicking it, or Enter/Space, opens the one
 * place to look: what the session is doing, then every person and their status.
 *
 * It replaces three things that each showed a part of this: the status chip's
 * own popover, a separate stack of avatars after the sync status, and a
 * bordered panel under the title bar that listed the vault's members.
 *
 * It renders NOTHING unless there is something to say. That is when the session
 * speaks for itself (`sessionSpeaksForItself`, which keeps the title bar silent
 * on a deployment that simply has no live collaboration), or when the note has
 * collaborators at all — someone in it right now, or other members of its shared
 * vault. A note nobody else can open, with no live room, contributes no markup.
 */
const CollaborationStatusIndicator: FunctionComponent<Props> = ({ note }) => {
  const noteUuid = note.uuid
  const state = useCollaborationStatus(noteUuid)
  const { peers } = usePresence(noteUuid)
  const [isOpen, setIsOpen] = useState(false)
  const [rosterRefreshKey, setRosterRefreshKey] = useState(0)
  const { members, selfUuid, selfEmail } = useVaultRoster(note, rosterRefreshKey)
  const [storedCollapsed, setStoredCollapsed] = useLocalPreference(COLLABORATORS_COLLAPSED_PREF_KEY)
  const collapsed = normalizeCollaboratorsCollapsed(storedCollapsed)
  const isDesktopScreen = useMediaQuery(MediaQueryBreakpoints.md)
  const [firstPreparationPhase, setFirstPreparationPhase] = useState<FirstPreparationPhase>('quiet')
  const [now, setNow] = useState(() => Date.now())
  const buttonRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const wasOpen = useRef(false)
  const dialogId = useId()

  const isFirstPreparation = state?.status.kind === 'preparing' && !state.hasBeenActive
  const isAwaitingPeerState = state?.status.kind === 'preparing' && state.status.awaitingPeerState === true

  useEffect(() => {
    if (!isFirstPreparation) {
      setFirstPreparationPhase('quiet')
      return
    }
    const show = setTimeout(() => setFirstPreparationPhase('visible'), PREPARING_QUIET_PERIOD_MS)
    const standDown = isAwaitingPeerState
      ? undefined
      : setTimeout(() => setFirstPreparationPhase('stood-down'), PREPARING_STAND_DOWN_MS)
    return () => {
      clearTimeout(show)
      if (standDown !== undefined) {
        clearTimeout(standDown)
      }
    }
  }, [isFirstPreparation, isAwaitingPeerState])

  // The registry says when a peer starts and stops typing, and when they act. The
  // one status it cannot announce is the absence of anything: somebody becoming
  // idle. That alone is read off a clock, coarsely, and only while there is
  // somebody whose activity is being tracked — otherwise there is no timer at all.
  const needsClock = presenceNeedsClock(peers)
  useEffect(() => {
    if (!needsClock) {
      return
    }
    const tick = setInterval(() => setNow(Date.now()), PRESENCE_CLOCK_TICK_MS)
    return () => clearInterval(tick)
  }, [needsClock])

  // Two things the registry does not keep, because they are about its history:
  // when it first listed each peer (what "idle" is measured from until they act),
  // and the name each account broadcast (kept for after they leave). Both helpers
  // hand back the same map when nothing changed, so this costs no render then.
  const [firstSeenAt, setFirstSeenAt] = useState<ReadonlyMap<number, number>>(() => new Map())
  const [rememberedNames, setRememberedNames] = useState<ReadonlyMap<string, string>>(() => new Map())
  useEffect(() => {
    setFirstSeenAt((previous) => trackFirstSeen(previous, peers, Date.now()))
    setRememberedNames((previous) => rememberBroadcastNames(previous, peers))
  }, [peers])

  const collaborators = useMemo(
    () => buildCollaborators({ peers, members, selfUuid, selfEmail, state, now, firstSeenAt, rememberedNames }),
    [peers, members, selfUuid, selfEmail, state, now, firstSeenAt, rememberedNames],
  )
  const others = collaborators.filter((collaborator) => !collaborator.isSelf)
  const present = others.filter((collaborator) => collaborator.isPresent)
  const isVisible = sessionSpeaksForItself(state, firstPreparationPhase) || others.length > 0

  const toggle = useCallback(() => {
    setIsOpen((open) => !open)
  }, [])

  // A trigger that went away takes its popup with it, and must not bring it back later.
  useEffect(() => {
    if (!isVisible) {
      setIsOpen(false)
    }
  }, [isVisible])

  useEffect(() => {
    if (!isOpen) {
      return
    }
    setRosterRefreshKey((key) => key + 1)

    // The popup is portalled to the end of the document, so Tab from the trigger
    // would never reach it: focus is moved in. The Popover keeps its content
    // unfocusable (`visibility: hidden`) until it has measured and placed it,
    // hence the retry — a focus() that did not take is simply tried next frame.
    let frame = 0
    let attempts = 0
    const focusDialog = (): void => {
      const dialog = dialogRef.current
      dialog?.focus({ preventScroll: true })
      if (dialog && document.activeElement === dialog) {
        return
      }
      attempts += 1
      if (attempts < FOCUS_ATTEMPT_FRAMES) {
        frame = requestAnimationFrame(focusDialog)
      }
    }
    focusDialog()
    return () => cancelAnimationFrame(frame)
  }, [isOpen])

  // Closing hands focus back to the trigger — unless the user has already put it
  // somewhere themselves, as a click into the editor does. A click on something
  // that takes no focus leaves it on the body, and that is handed back too.
  useEffect(() => {
    if (isOpen) {
      wasOpen.current = true
      return
    }
    if (!wasOpen.current) {
      return
    }
    wasOpen.current = false
    const active = document.activeElement
    if (!active || active === document.body || dialogRef.current?.contains(active)) {
      buttonRef.current?.focus({ preventScroll: true })
    }
  }, [isOpen])

  // Popover stamps `aria-haspopup="true"` — a menu — on its anchor and removes
  // `aria-expanded` when closed. This popup is a dialog, and a collapsed trigger
  // should say so. Parent effects run after a child's, so this has the last word.
  useEffect(() => {
    const button = buttonRef.current
    if (!button) {
      return
    }
    button.setAttribute('aria-haspopup', 'dialog')
    button.setAttribute('aria-expanded', isOpen ? 'true' : 'false')
  }, [isOpen, isVisible])

  const onTriggerKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>) => {
    // Focus normally lives inside the popup while it is open, where Popover
    // handles Escape itself; this is for when it is still on the trigger.
    if (event.key === 'Escape' && wasOpen.current) {
      event.stopPropagation()
      setIsOpen(false)
    }
  }, [])

  // Tabbing past either end of the popup closes it and lands on the trigger,
  // instead of wandering off into whatever follows a portal in the document.
  const leavePopup = useCallback(() => {
    setIsOpen(false)
    buttonRef.current?.focus({ preventScroll: true })
  }, [])

  const toggleCollapsed = useCallback(() => {
    setStoredCollapsed(!collapsed)
  }, [collapsed, setStoredCollapsed])

  if (!isVisible) {
    return null
  }

  const session = describeSession(state, firstPreparationPhase)
  const attendance = describeAttendance(collaborators, state?.status.kind === 'active')
  const label = attendance ? `${session.summary} ${attendance}` : session.summary
  const showAvatars = isDesktopScreen && !collapsed && present.length > 0
  const showCount = !showAvatars && present.length > 0

  return (
    <div className="note-status-tooltip-container mr-2">
      <button
        aria-controls={isOpen ? dialogId : undefined}
        aria-label={label}
        className="peer flex h-5 flex-shrink-0 cursor-pointer items-center rounded-full"
        data-testid={COLLABORATION_INDICATOR_TEST_ID}
        onClick={toggle}
        onKeyDown={onTriggerKeyDown}
        ref={buttonRef}
        title={label}
        type="button"
      >
        <span
          className={classNames(
            'flex h-5 flex-shrink-0 items-center justify-center rounded-full',
            showCount ? 'min-w-5 gap-0.5 px-1.5' : 'w-5',
            SESSION_TONE_CLASS[session.tone],
          )}
          data-collaboration-status-dot={session.tone}
        >
          <Icon className={session.animateIcon ? 'animate-spin' : ''} type={session.icon} size="small" />
          {showCount && (
            <span className="text-[0.65rem] leading-none font-bold" data-collaborator-count>
              {present.length}
            </span>
          )}
        </span>
        {showAvatars && <CollaboratorAvatarStack present={present} />}
      </button>
      <Popover
        title="Collaborators"
        open={isOpen}
        togglePopover={toggle}
        // A solid surface, at every width. From `md` up Popover is translucent and
        // counts on `backdrop-filter` to blur what is behind it; this popup opens
        // over the editor ribbon, and where the blur does not paint a list of
        // names sits on top of a row of toolbar labels. A page cannot ask whether
        // a supported filter was actually painted, so it does not depend on it.
        className={POPUP_SURFACE_CLASS}
        containerClassName="!min-w-0 !w-auto max-w-[90vw]"
        anchorElement={buttonRef}
        side="bottom"
        align="center"
        offset={6}
        disableMobileFullscreenTakeover
        disableApplyingMobileWidth
      >
        <CollaboratorsPopover
          attendance={attendance}
          collaborators={collaborators}
          collapsed={collapsed}
          id={dialogId}
          onLeave={leavePopup}
          onToggleCollapsed={isDesktopScreen && others.length > 0 ? toggleCollapsed : undefined}
          ref={dialogRef}
          session={session}
        />
      </Popover>
    </div>
  )
}

export default CollaborationStatusIndicator
