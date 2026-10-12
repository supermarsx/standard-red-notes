/**
 * Standard Red Notes — who is in a note, and what the session is doing, as plain
 * data. `CollaborationStatusIndicator` renders it; nothing here touches the DOM.
 *
 * Two sources are merged:
 *
 *  - LIVE PRESENCE (`PresenceRegistry`): a peer is listed only while their
 *    awareness state is live on the relay for this note. It is never derived
 *    from a timestamp of ours.
 *  - THE VAULT ROSTER: everyone the shared vault is shared with, and what each
 *    of them may do. It says who COULD be here, never who is.
 *
 * Every status below is a claim, so each one is only as strong as its source. A
 * member who is not in the live room is "not in this note" only while this
 * client is itself in that room; otherwise the honest answer is "unknown", and
 * it is the same answer for a read-only member, who never joins the room at all.
 */
import type { LocalPrefKey } from '@standardnotes/snjs'
import { CollaborationRoomState } from '../SuperEditor/Collaboration/CollaborationStatusRegistry'
import { PresentPeer } from '../SuperEditor/Collaboration/PresenceRegistry'
import { collaboratorColor, collaboratorInitials } from '../SuperEditor/Collaboration/collaboratorColor'

/** How many avatars the title bar shows before the rest fold into "+N". */
export const MAX_BAR_AVATARS = 3

/** A cursor that moved this recently counts as typing. */
export const TYPING_WINDOW_MS = 3_000

/** A peer whose cursor has not moved for this long is idle. */
export const IDLE_AFTER_MS = 2 * 60_000

/**
 * The local preference key, pinned as a string rather than read off the
 * `LocalPrefKey` enum object — for the reason `navigationMini.ts` documents at
 * length: web takes the enum's RUNTIME value from the generated `snjs` bundle,
 * where a newly added member is `undefined` until that bundle is rebuilt, and a
 * preference stored under the key `"undefined"` looks exactly like a switch that
 * does nothing. The cast is type-only, so `LocalPrefKey.ts` still types every
 * read and write, and `collaborators.spec.ts` reads the enum's SOURCE and fails
 * if the two strings ever stop matching.
 *
 * For the same reason every read compares against `true`: the bundle's
 * `LocalPrefDefaults` has no entry for the key either, so the default arrives as
 * `undefined`, which must mean "not collapsed".
 */
export const COLLABORATORS_COLLAPSED_PREF_KEY = 'collaboratorsCollapsed' as LocalPrefKey.CollaboratorsCollapsed

/** Coerce a stored, untrusted value. Only an explicit `true` collapses. */
export function normalizeCollaboratorsCollapsed(raw: unknown): boolean {
  return raw === true
}

export type CollaboratorPresence =
  /** In the live room, and their cursor moved within TYPING_WINDOW_MS. */
  | 'typing'
  /** In the live room with the editor focused. */
  | 'editing'
  /** In the live room with the editor not focused. */
  | 'viewing'
  /** In the live room, cursor still for IDLE_AFTER_MS. */
  | 'idle'
  /** In the live room; this client was told nothing more about them. */
  | 'here'
  /** Was in the live room when this client's own connection dropped. */
  | 'reconnecting'
  /** Could be in the live room and is not. */
  | 'away'
  /** Not in the live room, and that says nothing: see the file header. */
  | 'unknown'

export type CollaboratorRole = 'admin' | 'write' | 'read'

export type Collaborator = {
  key: string
  name: string
  /** Their cursor colour. */
  color: string
  initials: string
  presence: CollaboratorPresence
  /** What the vault lets them do. Absent when the note is in no shared vault. */
  role?: CollaboratorRole
  /** The signed-in account's own row. */
  isSelf: boolean
  /** Someone ELSE who is in the live room right now. */
  isPresent: boolean
  /** Own row only: this account also has the note open in another tab or device. */
  openElsewhere?: boolean
}

/** A member of the note's shared vault, as much as the app knows about them. */
export type RosterMember = {
  userUuid: string
  /** Their trusted-contact name, when the signed-in account has them as a contact. */
  contactName?: string
  role?: CollaboratorRole
}

const PRESENCE_ORDER: CollaboratorPresence[] = [
  'typing',
  'editing',
  'viewing',
  'here',
  'idle',
  'reconnecting',
  'away',
  'unknown',
]

const PRESENCE_LABEL: Record<CollaboratorPresence, string> = {
  typing: 'Typing',
  editing: 'Editing',
  viewing: 'Viewing',
  idle: 'Idle',
  here: 'In this note',
  reconnecting: 'Reconnecting',
  away: 'Not in this note',
  unknown: 'Unknown',
}

export function presenceLabel(presence: CollaboratorPresence): string {
  return PRESENCE_LABEL[presence]
}

const ROLE_LABEL: Record<CollaboratorRole, string> = {
  admin: 'Admin',
  write: 'Can edit',
  read: 'Read-only',
}

export function roleLabel(role: CollaboratorRole): string {
  return ROLE_LABEL[role]
}

/** The vault's permission string, or nothing when it is not one this app knows. */
export function roleFromPermission(permission: unknown): CollaboratorRole | undefined {
  return permission === 'admin' || permission === 'write' || permission === 'read' ? permission : undefined
}

type LiveActivity = Extract<CollaboratorPresence, 'typing' | 'editing' | 'viewing' | 'idle' | 'here'>

/**
 * What a present peer is doing, from the optional activity fields a peer's
 * awareness may carry: `typing`, `focusing` and `lastActiveAt`.
 *
 * `PresentPeer` does not declare them, so they are read by name and
 * type-checked here; a peer that carries none of them is simply `here`. That is
 * the whole degradation path — no field is ever assumed.
 */
export function peerActivity(peer: PresentPeer, now: number): LiveActivity {
  const fields = peer as unknown as Record<string, unknown>
  const lastActiveAt =
    typeof fields.lastActiveAt === 'number' && Number.isFinite(fields.lastActiveAt) ? fields.lastActiveAt : undefined
  const sinceActive = lastActiveAt === undefined ? undefined : now - lastActiveAt

  if (fields.typing === true || (sinceActive !== undefined && sinceActive >= 0 && sinceActive < TYPING_WINDOW_MS)) {
    return 'typing'
  }
  if (sinceActive !== undefined && sinceActive >= IDLE_AFTER_MS) {
    return 'idle'
  }
  if (fields.focusing === true) {
    return 'editing'
  }
  if (fields.focusing === false) {
    return 'viewing'
  }
  return 'here'
}

/** Whether any peer carries a timestamp, i.e. whether statuses can change with the clock alone. */
export function presenceNeedsClock(peers: PresentPeer[]): boolean {
  return peers.some((peer) => typeof (peer as unknown as Record<string, unknown>).lastActiveAt === 'number')
}

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

/**
 * The colour a peer's remote cursor is drawn in. Peers broadcast it, so it is
 * used only when it is a plain hex colour; anything else falls back to the same
 * deterministic colour every client derives from the account id.
 */
function cursorColor(broadcast: string | undefined, stableId: string): string {
  return broadcast !== undefined && HEX_COLOR.test(broadcast) ? broadcast : collaboratorColor(stableId)
}

/**
 * Whether the peers in the registry can be taken at their word. They can while
 * this client is in the room — including a newcomer still waiting for a peer's
 * copy, whose awareness is already live. Once a room that WAS live drops, the
 * registry may keep the last peers for a while, and they are then shown as
 * reconnecting instead of as present.
 */
function peersAreLive(state: CollaborationRoomState | undefined): boolean {
  if (!state || state.status.kind === 'active') {
    return true
  }
  return state.status.kind === 'preparing' && !state.hasBeenActive
}

type BuildInput = {
  peers: PresentPeer[]
  members: RosterMember[]
  selfUuid: string | undefined
  /** Used only for the initials on the signed-in account's own row. */
  selfEmail?: string
  state: CollaborationRoomState | undefined
  now: number
}

/**
 * One row per person: those in the live room first (most active first), then
 * the vault members who are not, then the signed-in account itself.
 *
 * A person with the note open in two tabs is one row, showing the most active
 * of the two. The signed-in account's own other tabs and devices are never
 * counted as a collaborator; they are reported on its own row instead.
 */
export function buildCollaborators({ peers, members, selfUuid, selfEmail, state, now }: BuildInput): Collaborator[] {
  const live = peersAreLive(state)
  const roster = new Map(members.map((member) => [member.userUuid, member]))

  const present = new Map<string, { peer: PresentPeer; activity: LiveActivity }>()
  let openElsewhere = false
  for (const peer of peers) {
    if (selfUuid !== undefined && peer.userUuid === selfUuid) {
      openElsewhere = true
      continue
    }
    const key = peer.userUuid ?? `client:${peer.clientId}`
    const activity = peerActivity(peer, now)
    const existing = present.get(key)
    if (!existing || PRESENCE_ORDER.indexOf(activity) < PRESENCE_ORDER.indexOf(existing.activity)) {
      present.set(key, { peer: existing?.peer ?? peer, activity })
    }
  }

  const others: Collaborator[] = []
  for (const [key, { peer, activity }] of present) {
    const member = peer.userUuid === undefined ? undefined : roster.get(peer.userUuid)
    const name = member?.contactName || peer.name
    others.push({
      key,
      name,
      color: cursorColor(peer.color, peer.userUuid ?? String(peer.clientId)),
      initials: collaboratorInitials(name),
      presence: live ? activity : 'reconnecting',
      ...(member?.role ? { role: member.role } : {}),
      isSelf: false,
      isPresent: true,
    })
  }

  const roomIsLive = state?.status.kind === 'active'
  for (const member of members) {
    if (member.userUuid === selfUuid || present.has(member.userUuid)) {
      continue
    }
    // As elsewhere in the app, a member who is not a trusted contact is known only by account id.
    const name = member.contactName || member.userUuid
    others.push({
      key: member.userUuid,
      name,
      color: collaboratorColor(member.userUuid),
      initials: collaboratorInitials(name),
      presence: roomIsLive && member.role !== 'read' ? 'away' : 'unknown',
      ...(member.role ? { role: member.role } : {}),
      isSelf: false,
      isPresent: false,
    })
  }

  // Within a status, people with a name come before those known only by account id.
  const idOnly = (collaborator: Collaborator): number => (collaborator.name === collaborator.key ? 1 : 0)
  others.sort(
    (a, b) =>
      PRESENCE_ORDER.indexOf(a.presence) - PRESENCE_ORDER.indexOf(b.presence) ||
      idOnly(a) - idOnly(b) ||
      a.name.localeCompare(b.name) ||
      a.key.localeCompare(b.key),
  )

  const self = selfUuid === undefined ? undefined : roster.get(selfUuid)
  if (selfUuid !== undefined && (self || openElsewhere)) {
    others.push({
      key: selfUuid,
      name: 'You',
      color: collaboratorColor(selfUuid),
      initials: collaboratorInitials(selfEmail || 'You'),
      presence: 'here',
      ...(self?.role ? { role: self.role } : {}),
      isSelf: true,
      isPresent: false,
      ...(openElsewhere ? { openElsewhere: true } : {}),
    })
  }

  return others
}

/** Why a status reads "Unknown", for the one row where that needs saying. */
export function unknownPresenceReason(collaborator: Collaborator): string {
  return collaborator.role === 'read'
    ? 'Read-only members do not join live editing, so it cannot be told whether they have this note open.'
    : 'Live collaboration is not running, so it cannot be told who has this note open.'
}

export type SessionTone =
  /** A live encrypted room. */
  | 'live'
  /** Setting up; nothing is wrong. */
  | 'busy'
  /** Something the user was relying on is not there. */
  | 'warning'
  /** Not running, and that is not news. */
  | 'quiet'

export type SessionPresentation = {
  tone: SessionTone
  /** Only ever one of these three, each of which `IconNameToSvgMapping` draws. */
  icon: 'user' | 'sync' | 'cloud-off'
  animateIcon: boolean
  /** The session in one or two sentences: the start of the trigger's accessible name. */
  summary: string
  heading: string
  detail: string
}

/** Where a first, never-yet-live preparation is in its life. See the indicator. */
export type FirstPreparationPhase = 'quiet' | 'visible' | 'stood-down'

/**
 * Whether the session has something to say BY ITSELF — the rule that keeps the
 * title bar silent on a note nobody shares:
 *
 *  - no entry in the registry (no Super editor owns the note) -> silent
 *  - unavailable and never once live -> silent, because "this deployment has no
 *    live collaboration" is not news on every note open — UNLESS the room's
 *    automatic retries have stood down (`retriesExhausted`): the gateway was
 *    reachable and still refused three times, which the user must be able to see
 *  - preparing for the first time -> silent until the quiet period has passed,
 *    and silent again once it has stood down without settling — except while
 *    waiting for a collaborator's copy, when the editor is locked and the wait
 *    is bounded, so that phase never stands down
 */
export function sessionSpeaksForItself(
  state: CollaborationRoomState | undefined,
  phase: FirstPreparationPhase,
): boolean {
  if (!state) {
    return false
  }
  if (state.status.kind === 'unavailable') {
    return state.hasBeenActive || state.status.retriesExhausted === true
  }
  if (state.status.kind === 'preparing' && !state.hasBeenActive) {
    return phase === 'visible'
  }
  return true
}

export function describeSession(
  state: CollaborationRoomState | undefined,
  phase: FirstPreparationPhase,
): SessionPresentation {
  if (!state) {
    return {
      tone: 'quiet',
      icon: 'user',
      animateIcon: false,
      summary: 'Live collaboration is not running for this note.',
      heading: 'Live collaboration is not running',
      detail: 'This note is not being edited live. Changes to it are still saved and synced as usual.',
    }
  }

  if (state.status.kind === 'active') {
    return {
      tone: 'live',
      icon: 'user',
      animateIcon: false,
      summary: 'Encrypted collaboration active.',
      heading: 'Encrypted collaboration active',
      detail: 'End-to-end encrypted live editing is on.',
    }
  }

  if (state.status.kind === 'preparing') {
    if (state.hasBeenActive) {
      return {
        tone: 'warning',
        icon: 'sync',
        animateIcon: true,
        summary: 'Reconnecting encrypted collaboration. Your edits are still being saved.',
        heading: 'Reconnecting encrypted collaboration',
        detail: 'Live editing dropped and is reconnecting. Your edits are still saved as usual meanwhile.',
      }
    }
    if (state.status.awaitingPeerState) {
      return {
        tone: 'warning',
        icon: 'sync',
        animateIcon: true,
        summary: "Waiting for a collaborator's copy of this note. Editing resumes when it arrives.",
        heading: 'Waiting for a collaborator',
        detail:
          "This note is being edited live elsewhere and a collaborator's copy has not arrived yet. " +
          'The editor is read-only until it does; if no one answers, this device takes over shortly.',
      }
    }
    if (phase === 'stood-down') {
      return {
        tone: 'quiet',
        icon: 'cloud-off',
        animateIcon: false,
        summary: 'Live collaboration paused.',
        heading: 'Live collaboration paused',
        detail:
          'The encrypted room has not finished setting up, so live editing is paused. ' +
          'Your edits are still saved as usual.',
      }
    }
    return {
      tone: phase === 'visible' ? 'busy' : 'quiet',
      icon: phase === 'visible' ? 'sync' : 'user',
      animateIcon: phase === 'visible',
      summary: 'Preparing encrypted collaboration. You can keep editing.',
      heading: 'Preparing encrypted collaboration',
      detail: 'Setting up the end-to-end encrypted room. You can keep editing while this finishes.',
    }
  }

  if (!state.hasBeenActive && !state.status.retriesExhausted) {
    return {
      tone: 'quiet',
      icon: 'cloud-off',
      animateIcon: false,
      summary: `Live collaboration paused. ${state.status.reason}`,
      heading: 'Live collaboration paused',
      detail: state.status.reason,
    }
  }

  const standDown = state.status.retriesExhausted
    ? ' Automatic retries have paused; they resume when you return to this tab or edit the note.'
    : ''
  return {
    tone: 'warning',
    icon: 'cloud-off',
    animateIcon: false,
    summary: `Encrypted collaboration unavailable. ${state.status.reason}`,
    heading: 'Encrypted collaboration unavailable',
    detail: `${state.status.reason}${standDown}`,
  }
}

const MAX_NAMES_IN_LABEL = 3

/**
 * Who is here, as one sentence. It always carries the count, because it becomes
 * part of the trigger's accessible name and the trigger shows only initials.
 */
export function describeAttendance(collaborators: Collaborator[], roomIsLive: boolean): string {
  const others = collaborators.filter((collaborator) => !collaborator.isSelf)
  const present = others.filter((collaborator) => collaborator.isPresent)

  if (present.length > 0) {
    const named = present.slice(0, MAX_NAMES_IN_LABEL).map((collaborator) => collaborator.name)
    const unnamed = present.length - named.length
    const names = unnamed > 0 ? `${named.join(', ')} and ${unnamed} more` : named.join(', ')
    return `${present.length} ${present.length === 1 ? 'collaborator' : 'collaborators'} here now: ${names}.`
  }

  const access =
    others.length === 0
      ? ''
      : `${others.length} other ${others.length === 1 ? 'person has' : 'people have'} access to this note.`
  if (roomIsLive) {
    return `No one else is in this note right now.${access ? ` ${access}` : ''}`
  }
  return access
}
