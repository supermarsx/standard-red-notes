/**
 * Standard Red Notes — who is in a note, and what the session is doing, as plain
 * data. `CollaborationStatusIndicator` renders it; nothing here touches the DOM.
 *
 * Two sources are merged:
 *
 *  - LIVE PRESENCE (`PresenceRegistry`): a peer is listed only while their
 *    awareness state is live on the relay for this note, with what the registry
 *    saw them do: whether they are typing, whether their editor has focus, and
 *    when they last did anything. Nobody is ever listed, or called reconnecting,
 *    because they merely stopped being listed.
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

/** A peer who has neither edited nor moved their caret for this long is idle. */
export const IDLE_AFTER_MS = 2 * 60_000

/**
 * How often the statuses are re-read against the clock. "Idle" is the only one
 * that changes with time alone, and it is two minutes away, so this is coarse.
 */
export const PRESENCE_CLOCK_TICK_MS = 15_000

/** What a vault member is called when this device has no name for them. */
export const UNKNOWN_MEMBER_NAME = 'Unknown member'

/** How many broadcast names are remembered for people who have since left. */
const MAX_REMEMBERED_NAMES = 64

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
  /** In the live room, and an edit of theirs landed here within the last few seconds. */
  | 'typing'
  /** In the live room with the editor focused. */
  | 'editing'
  /** In the live room with the editor not focused. */
  | 'viewing'
  /** In the live room, with no edit and no caret move for IDLE_AFTER_MS. */
  | 'idle'
  /** In the live room; this client was told nothing more about them. */
  | 'here'
  /**
   * Listed, but not to be taken as here: either the registry itself reports this
   * person as reconnecting, or this client's own connection dropped and the
   * people it last saw may no longer be there.
   */
  | 'reconnecting'
  /** Could be in the live room and is not. */
  | 'away'
  /** Not in the live room, and that says nothing: see the file header. */
  | 'unknown'

export type CollaboratorRole = 'admin' | 'write' | 'read'

export type Collaborator = {
  key: string
  name: string
  /**
   * Set only when `name` is UNKNOWN_MEMBER_NAME: the account id that is all this
   * device knows about them. It is what the vault members screen shows, so it is
   * kept within reach for telling two such people apart.
   */
  accountId?: string
  /** Their cursor colour. */
  color: string
  initials: string
  presence: CollaboratorPresence
  /** What the vault lets them do. Absent when the note is in no shared vault. */
  role?: CollaboratorRole
  /** The signed-in account's own row. */
  isSelf: boolean
  /** Someone ELSE whom the registry lists for this note — reconnecting included. */
  isPresent: boolean
  /** Own row only: this account also has the note open in another tab or device. */
  openElsewhere?: boolean
  /** Known live browser profiles; absent when older peers lack a device identity. */
  connectedDevices?: number
  /** Live editor sessions, including this one for the signed-in account. */
  connectedSessions?: number
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

type PeerState = Extract<CollaboratorPresence, 'typing' | 'editing' | 'viewing' | 'idle' | 'here' | 'reconnecting'>

/**
 * What one listed peer is doing, read off exactly what the registry reports
 * about them and nothing else:
 *
 *  - `reconnecting` — the registry says this peer is only reconnecting. (It does
 *    not report that yet; the field is read by name, so it shows the day it does.)
 *  - `typing` — an edit of theirs landed here in the last few seconds. Only this
 *    flag means typing: a caret move is activity, but it is not typing.
 *  - `lastActiveAt` — their last edit or caret move, which is what "idle" is
 *    measured from. A peer who has done nothing since they were first listed has
 *    none, so `firstSeenAt` — when the registry first listed them — stands in,
 *    but only for a peer whose activity is being tracked at all (`typing` is a
 *    boolean). For one that is not, silence is not idleness.
 *  - `focusing` — whether their editor has keyboard focus.
 *
 * A peer that carries none of it is simply `here`.
 */
export function peerActivity(peer: PresentPeer, now: number, firstSeenAt?: number): PeerState {
  const fields = peer as unknown as Record<string, unknown>
  if (fields.reconnecting === true) {
    return 'reconnecting'
  }
  if (fields.typing === true) {
    return 'typing'
  }

  const lastActiveAt =
    typeof fields.lastActiveAt === 'number' && Number.isFinite(fields.lastActiveAt) ? fields.lastActiveAt : undefined
  const quietSince = lastActiveAt ?? (typeof fields.typing === 'boolean' ? firstSeenAt : undefined)
  if (quietSince !== undefined && now - quietSince >= IDLE_AFTER_MS) {
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

/**
 * Whether a status can change with the clock alone — that is, whether anybody
 * listed could become idle without the registry saying anything new.
 */
export function presenceNeedsClock(peers: PresentPeer[]): boolean {
  return peers.some((peer) => {
    const fields = peer as unknown as Record<string, unknown>
    return typeof fields.typing === 'boolean' || typeof fields.lastActiveAt === 'number'
  })
}

/**
 * When the registry first listed each peer that is listed now, by yjs client id.
 * Returns `previous` itself when nobody arrived or left, so it can be held in
 * state without causing a render of its own.
 */
export function trackFirstSeen(
  previous: ReadonlyMap<number, number>,
  peers: PresentPeer[],
  now: number,
): ReadonlyMap<number, number> {
  const unchanged = peers.length === previous.size && peers.every((peer) => previous.has(peer.clientId))
  if (unchanged) {
    return previous
  }
  return new Map(peers.map((peer) => [peer.clientId, previous.get(peer.clientId) ?? now]))
}

/**
 * The name each account last broadcast, kept after they leave. A member who is
 * not a trusted contact has no other name on this device, so without this their
 * row would turn from their e-mail into "Unknown member" the moment they left.
 * Returns `previous` itself when nothing new was learnt.
 */
export function rememberBroadcastNames(
  previous: ReadonlyMap<string, string>,
  peers: PresentPeer[],
): ReadonlyMap<string, string> {
  const learnt = new Map<string, string>()
  for (const peer of peers) {
    if (peer.userUuid !== undefined && peer.name !== '' && previous.get(peer.userUuid) !== peer.name) {
      learnt.set(peer.userUuid, peer.name)
    }
  }
  if (learnt.size === 0) {
    return previous
  }
  const next = new Map(previous)
  for (const [userUuid, name] of learnt) {
    // Re-inserted, so the names seen most recently are the ones kept at the cap.
    next.delete(userUuid)
    next.set(userUuid, name)
  }
  for (const oldest of next.keys()) {
    if (next.size <= MAX_REMEMBERED_NAMES) {
      break
    }
    next.delete(oldest)
  }
  return next
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
 * registry may keep the last peers for a while, and every one of them is then
 * shown as reconnecting instead of as present: it is this client that lost them.
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
  selfDeviceId?: string
  state: CollaborationRoomState | undefined
  now: number
  /** From `trackFirstSeen`. Without it nobody becomes idle before their first move. */
  firstSeenAt?: ReadonlyMap<number, number>
  /** From `rememberBroadcastNames`. */
  rememberedNames?: ReadonlyMap<string, string>
}

/**
 * One row per person: those in the live room first (most active first), then
 * the vault members who are not, then the signed-in account itself.
 *
 * A person with the note open in two tabs is one row, showing the most active
 * of the two — so one tab reconnecting does not make the person reconnecting
 * while the other is live. The signed-in account's own other tabs and devices
 * are never counted as a collaborator; they are reported on its own row instead.
 */
export function buildCollaborators({
  peers,
  members,
  selfUuid,
  selfEmail,
  selfDeviceId,
  state,
  now,
  firstSeenAt,
  rememberedNames,
}: BuildInput): Collaborator[] {
  const live = peersAreLive(state)
  const roster = new Map(members.map((member) => [member.userUuid, member]))

  const present = new Map<string, { peer: PresentPeer; activity: PeerState; peers: PresentPeer[] }>()
  const selfPeers: PresentPeer[] = []
  let openElsewhere = false
  for (const peer of peers) {
    if (selfUuid !== undefined && peer.userUuid === selfUuid) {
      openElsewhere = true
      selfPeers.push(peer)
      continue
    }
    const key = peer.userUuid ?? `client:${peer.clientId}`
    const activity = peerActivity(peer, now, firstSeenAt?.get(peer.clientId))
    const existing = present.get(key)
    if (!existing || PRESENCE_ORDER.indexOf(activity) < PRESENCE_ORDER.indexOf(existing.activity)) {
      present.set(key, { peer: existing?.peer ?? peer, activity, peers: [...(existing?.peers ?? []), peer] })
    } else {
      existing.peers.push(peer)
    }
  }

  const others: Collaborator[] = []
  for (const [key, { peer, activity, peers: sessions }] of present) {
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
      ...(live ? countConnections(sessions) : {}),
    })
  }

  const roomIsLive = state?.status.kind === 'active'
  for (const member of members) {
    if (member.userUuid === selfUuid || present.has(member.userUuid)) {
      continue
    }
    // The vault knows a member only by account id. A name comes from a trusted contact, or from
    // what the person broadcast while they were here; failing both, they are not given one.
    const name = member.contactName || rememberedNames?.get(member.userUuid)
    others.push({
      key: member.userUuid,
      name: name ?? UNKNOWN_MEMBER_NAME,
      ...(name === undefined ? { accountId: member.userUuid } : {}),
      color: collaboratorColor(member.userUuid),
      initials: name === undefined ? '?' : collaboratorInitials(name),
      presence: roomIsLive && member.role !== 'read' ? 'away' : 'unknown',
      ...(member.role ? { role: member.role } : {}),
      isSelf: false,
      isPresent: false,
    })
  }

  // Within a status, people with a name come before those known only by account id.
  const unnamed = (collaborator: Collaborator): number => (collaborator.accountId === undefined ? 0 : 1)
  others.sort(
    (a, b) =>
      PRESENCE_ORDER.indexOf(a.presence) - PRESENCE_ORDER.indexOf(b.presence) ||
      unnamed(a) - unnamed(b) ||
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
      ...(state?.status.kind === 'active' ? countConnections(selfPeers, selfDeviceId, true) : {}),
    })
  }

  return others
}

function countConnections(
  peers: PresentPeer[],
  localDeviceId?: string,
  includeLocal = false,
): Pick<Collaborator, 'connectedDevices' | 'connectedSessions'> {
  const sessions = new Map(peers.map((peer) => [peer.clientId, peer]))
  const deviceIds = new Set([...sessions.values()].map((peer) => peer.deviceId).filter((id): id is string => !!id))
  if (localDeviceId) {
    deviceIds.add(localDeviceId)
  }
  const allKnown = [...sessions.values()].every((peer) => !!peer.deviceId) && (!includeLocal || !!localDeviceId)
  return {
    connectedSessions: sessions.size + Number(includeLocal),
    ...(allKnown ? { connectedDevices: deviceIds.size } : {}),
  }
}

export function connectedDeviceLabel(collaborator: Collaborator): string | undefined {
  const sessions = collaborator.connectedSessions
  if (!sessions) {
    return undefined
  }
  if (collaborator.connectedDevices === undefined) {
    return `${sessions} connection${sessions === 1 ? '' : 's'}`
  }
  const devices = collaborator.connectedDevices
  const label = `${devices} device${devices === 1 ? '' : 's'}`
  return sessions > devices ? `${label} · ${sessions} tabs` : label
}

/**
 * What there is to say about a member this device cannot name, in the words the
 * vault members screen uses for the same person ("Not in your contacts").
 */
export function unknownMemberExplanation(accountId: string): string {
  return `Not in your contacts, so this device has no name for them. Account ${accountId}.`
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
  const here = present.filter((collaborator) => collaborator.presence !== 'reconnecting')
  const reconnecting = present.filter((collaborator) => collaborator.presence === 'reconnecting')

  const counted = (people: Collaborator[], what: string): string => {
    const named = people.slice(0, MAX_NAMES_IN_LABEL).map((collaborator) => collaborator.name)
    const more = people.length - named.length
    const names = more > 0 ? `${named.join(', ')} and ${more} more` : named.join(', ')
    return `${people.length} ${what}: ${names}.`
  }

  if (present.length > 0) {
    const sentences: string[] = []
    if (here.length > 0) {
      sentences.push(counted(here, `${here.length === 1 ? 'collaborator' : 'collaborators'} here now`))
    }
    if (reconnecting.length > 0) {
      // After "N here now" the noun is understood; standing alone, the sentence has to carry it.
      const who = here.length > 0 ? '' : reconnecting.length === 1 ? 'collaborator ' : 'collaborators '
      sentences.push(counted(reconnecting, `${who}reconnecting`))
    }
    return sentences.join(' ')
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
