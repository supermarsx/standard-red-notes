import { readFileSync } from 'fs'
import { join } from 'path'

import { IconNameToSvgMapping } from '../Icon/IconNameToSvgMapping'
import { CollaborationRoomState } from '../SuperEditor/Collaboration/CollaborationStatusRegistry'
import { PresentPeer } from '../SuperEditor/Collaboration/PresenceRegistry'
import { collaboratorColor } from '../SuperEditor/Collaboration/collaboratorColor'
import {
  buildCollaborators,
  connectedDeviceLabel,
  COLLABORATORS_COLLAPSED_PREF_KEY,
  describeAttendance,
  describeSession,
  FirstPreparationPhase,
  IDLE_AFTER_MS,
  normalizeCollaboratorsCollapsed,
  peerActivity,
  presenceLabel,
  presenceNeedsClock,
  rememberBroadcastNames,
  roleFromPermission,
  roleLabel,
  RosterMember,
  sessionSpeaksForItself,
  trackFirstSeen,
  UNKNOWN_MEMBER_NAME,
  unknownMemberExplanation,
  unknownPresenceReason,
} from './collaborators'

const NOW = 1_800_000_000_000

const peer = (clientId: number, fields: Record<string, unknown> = {}): PresentPeer =>
  ({ clientId, name: `peer-${clientId}@example.com`, color: '#2563eb', ...fields }) as PresentPeer

const ACTIVE: CollaborationRoomState = { status: { kind: 'active' }, hasBeenActive: true }
const RECONNECTING: CollaborationRoomState = { status: { kind: 'preparing' }, hasBeenActive: true }
const NEWCOMER: CollaborationRoomState = {
  status: { kind: 'preparing', awaitingPeerState: true },
  hasBeenActive: false,
}
const PAUSED: CollaborationRoomState = {
  status: { kind: 'unavailable', reason: 'Live collaboration is offline.' },
  hasBeenActive: false,
}

describe('the collapsed preference', () => {
  it('is stored under the string the LocalPrefKey enum declares in its source', () => {
    // The enum's RUNTIME value comes from a generated bundle that lags its source,
    // so the literal is compared with the source text rather than with the import.
    const source = readFileSync(
      join(__dirname, '../../../../../services/src/Domain/Preferences/LocalPrefKey.ts'),
      'utf8',
    )
    const declared = source.match(/^\s*CollaboratorsCollapsed = '([^']+)',$/m)

    expect(declared).not.toBeNull()
    expect(COLLABORATORS_COLLAPSED_PREF_KEY).toBe(declared?.[1])
  })

  it('collapses only on an explicit true', () => {
    expect(normalizeCollaboratorsCollapsed(true)).toBe(true)
    for (const stored of [undefined, null, false, 'true', 1, {}]) {
      expect(normalizeCollaboratorsCollapsed(stored)).toBe(false)
    }
  })
})

describe('what a listed peer is doing', () => {
  it('is simply "here" when the registry reports nothing about their activity', () => {
    expect(peerActivity(peer(1), NOW)).toBe('here')
    expect(presenceNeedsClock([peer(1)])).toBe(false)
  })

  it('reads focus as editing or viewing', () => {
    expect(peerActivity(peer(1, { typing: false, focusing: true }), NOW)).toBe('editing')
    expect(peerActivity(peer(1, { typing: false, focusing: false }), NOW)).toBe('viewing')
  })

  it('reads the typing flag, which outranks focus', () => {
    expect(peerActivity(peer(1, { typing: true, focusing: false }), NOW)).toBe('typing')
    expect(peerActivity(peer(1, { typing: false, focusing: true }), NOW)).toBe('editing')
  })

  it('does not call a caret move typing, however recent', () => {
    // `lastActiveAt` covers caret and selection moves too. Only the flag means typing.
    expect(peerActivity(peer(1, { typing: false, focusing: true, lastActiveAt: NOW }), NOW)).toBe('editing')
    expect(peerActivity(peer(1, { focusing: false, lastActiveAt: NOW - 1 }), NOW)).toBe('viewing')
  })

  it('calls someone idle once they have neither edited nor moved for the idle period', () => {
    const quiet = (ago: number, more: Record<string, unknown> = {}) =>
      peerActivity(peer(1, { typing: false, focusing: true, lastActiveAt: NOW - ago, ...more }), NOW)

    expect(quiet(IDLE_AFTER_MS - 1)).toBe('editing')
    expect(quiet(IDLE_AFTER_MS)).toBe('idle')
    expect(quiet(IDLE_AFTER_MS * 10, { focusing: false })).toBe('idle')
    // Typing is the registry seeing an edit now; it is not overruled by an old timestamp.
    expect(quiet(IDLE_AFTER_MS * 10, { typing: true })).toBe('typing')
  })

  it('measures idle from when a peer was first listed, until they do something', () => {
    // The registry gives no timestamp to a peer who has done nothing since they arrived —
    // the person who opens the note and walks away, who is exactly who "idle" is for.
    const tracked = peer(1, { typing: false, focusing: true })

    expect(peerActivity(tracked, NOW)).toBe('editing')
    expect(peerActivity(tracked, NOW, NOW - IDLE_AFTER_MS + 1)).toBe('editing')
    expect(peerActivity(tracked, NOW, NOW - IDLE_AFTER_MS)).toBe('idle')
    // Once they act, that is what counts, not when they arrived.
    expect(peerActivity({ ...tracked, lastActiveAt: NOW - 5 } as PresentPeer, NOW, NOW - IDLE_AFTER_MS * 3)).toBe(
      'editing',
    )
  })

  it('does not take silence for idleness from a peer whose activity is not tracked at all', () => {
    expect(peerActivity(peer(1, { focusing: true }), NOW, NOW - IDLE_AFTER_MS * 3)).toBe('editing')
    expect(peerActivity(peer(1), NOW, NOW - IDLE_AFTER_MS * 3)).toBe('here')
  })

  it('reports a peer the registry says is reconnecting as that, whatever else it carries', () => {
    expect(peerActivity(peer(1, { reconnecting: true, typing: true, focusing: true }), NOW)).toBe('reconnecting')
    expect(peerActivity(peer(1, { reconnecting: false, typing: false, focusing: true }), NOW)).toBe('editing')
    expect(peerActivity(peer(1, { reconnecting: 'yes', focusing: true }), NOW)).toBe('editing')
  })

  it('ignores fields of the wrong type instead of guessing from them', () => {
    expect(
      peerActivity(peer(1, { typing: 'yes', focusing: 'true', lastActiveAt: `${NOW - IDLE_AFTER_MS}` }), NOW),
    ).toBe('here')
    expect(peerActivity(peer(1, { lastActiveAt: Number.NaN }), NOW)).toBe('here')
    // A timestamp ahead of this clock is not idle either.
    expect(peerActivity(peer(1, { typing: false, lastActiveAt: NOW + IDLE_AFTER_MS * 3 }), NOW)).toBe('here')
  })

  it('needs a clock only while somebody listed could turn idle', () => {
    expect(presenceNeedsClock([])).toBe(false)
    expect(presenceNeedsClock([peer(1), peer(2, { focusing: true })])).toBe(false)
    expect(presenceNeedsClock([peer(1), peer(2, { typing: false })])).toBe(true)
    expect(presenceNeedsClock([peer(1, { lastActiveAt: NOW })])).toBe(true)
  })
})

describe("the registry's history, which it does not keep itself", () => {
  it('records when each peer was first listed and forgets those who left', () => {
    const first = trackFirstSeen(new Map(), [peer(1), peer(2)], NOW)
    expect([...first]).toEqual([
      [1, NOW],
      [2, NOW],
    ])

    const later = trackFirstSeen(first, [peer(2), peer(3)], NOW + 5_000)
    expect([...later]).toEqual([
      [2, NOW],
      [3, NOW + 5_000],
    ])
  })

  it('hands back the same map when nobody arrived or left, so holding it costs no render', () => {
    const first = trackFirstSeen(new Map(), [peer(1), peer(2)], NOW)

    expect(trackFirstSeen(first, [peer(2, { typing: true }), peer(1)], NOW + 5_000)).toBe(first)
    expect(trackFirstSeen(first, [peer(1)], NOW + 5_000)).not.toBe(first)
  })

  it('remembers the name each account broadcast, and keeps the latest', () => {
    const first = rememberBroadcastNames(new Map(), [
      peer(1, { userUuid: 'eli', name: 'eli@example.com' }),
      peer(2, { name: 'no account id' }),
      peer(3, { userUuid: 'blank', name: '' }),
    ])
    expect([...first]).toEqual([['eli', 'eli@example.com']])

    expect(rememberBroadcastNames(first, [peer(1, { userUuid: 'eli', name: 'eli@example.com' })])).toBe(first)
    expect(rememberBroadcastNames(first, [])).toBe(first)
    expect(rememberBroadcastNames(first, [peer(9, { userUuid: 'eli', name: 'Eli F.' })]).get('eli')).toBe('Eli F.')
  })

  it('remembers a bounded number of names, dropping the ones seen longest ago', () => {
    let names: ReadonlyMap<string, string> = new Map()
    for (let index = 0; index < 70; index++) {
      names = rememberBroadcastNames(names, [peer(index, { userUuid: `account-${index}`, name: `name-${index}` })])
    }

    expect(names.size).toBe(64)
    expect(names.has('account-5')).toBe(false)
    expect(names.get('account-69')).toBe('name-69')
  })
})

describe('connected device counts', () => {
  const list = (peers: PresentPeer[], state = ACTIVE) =>
    buildCollaborators({
      peers,
      members: [],
      selfUuid: 'self',
      selfDeviceId: 'local-profile',
      state,
      now: NOW,
    })

  it('groups several tabs by device while keeping one row per account', () => {
    const [ada] = list([
      peer(1, { userUuid: 'ada', deviceId: 'phone' }),
      peer(2, { userUuid: 'ada', deviceId: 'laptop' }),
      peer(3, { userUuid: 'ada', deviceId: 'laptop' }),
    ])
    expect(ada).toMatchObject({ connectedDevices: 2, connectedSessions: 3 })
    expect(connectedDeviceLabel(ada)).toBe('2 devices · 3 tabs')
  })

  it('includes this tab once and deduplicates this account other tabs on the same device', () => {
    const [self] = list([
      peer(1, { userUuid: 'self', deviceId: 'local-profile' }),
      peer(2, { userUuid: 'self', deviceId: 'phone' }),
    ])
    expect(self).toMatchObject({ isSelf: true, connectedDevices: 2, connectedSessions: 3 })
  })

  it('updates counts when connections leave and ignores duplicated awareness entries', () => {
    const first = peer(1, { userUuid: 'ada', deviceId: 'phone' })
    const second = peer(2, { userUuid: 'ada', deviceId: 'laptop' })
    expect(list([first, first, second])[0]).toMatchObject({ connectedDevices: 2, connectedSessions: 2 })
    expect(connectedDeviceLabel(list([first])[0])).toBe('1 device')
  })

  it('does not invent devices for older peers or assert stale peers are connected', () => {
    const ada = peer(1, { userUuid: 'ada' })
    expect(connectedDeviceLabel(list([ada])[0])).toBe('1 connection')
    const stale = list([ada], { status: { kind: 'unavailable', reason: 'offline' }, hasBeenActive: true })[0]
    expect(connectedDeviceLabel(stale)).toBeUndefined()
  })
})

describe('who is listed', () => {
  const roster: RosterMember[] = [
    { userUuid: 'self', role: 'admin' },
    { userUuid: 'ada', contactName: 'Ada Lovelace', role: 'write' },
    { userUuid: 'grace', contactName: 'Grace Hopper', role: 'write' },
    { userUuid: 'rex', role: 'read' },
  ]

  it('lists nobody for a note that is in no shared vault and has no live room', () => {
    expect(buildCollaborators({ peers: [], members: [], selfUuid: 'self', state: undefined, now: NOW })).toEqual([])
  })

  it('puts those in the room first, then the other members, then the signed-in account', () => {
    const collaborators = buildCollaborators({
      peers: [peer(7, { userUuid: 'grace', name: 'grace@example.com' })],
      members: roster,
      selfUuid: 'self',
      selfEmail: 'me@example.com',
      state: ACTIVE,
      now: NOW,
    })

    expect(collaborators.map((collaborator) => [collaborator.key, collaborator.presence])).toEqual([
      ['grace', 'here'],
      ['ada', 'away'],
      ['rex', 'unknown'],
      ['self', 'here'],
    ])
    expect(collaborators.map((collaborator) => collaborator.isPresent)).toEqual([true, false, false, false])
    expect(collaborators[3]).toMatchObject({ name: 'You', isSelf: true, role: 'admin', initials: 'ME' })
  })

  it('names a present member by trusted-contact name, and a stranger by what they broadcast', () => {
    const collaborators = buildCollaborators({
      peers: [
        peer(1, { userUuid: 'ada', name: 'ada@example.com' }),
        peer(2, { userUuid: 'stranger', name: 'someone@example.com' }),
      ],
      members: roster,
      selfUuid: 'self',
      state: ACTIVE,
      now: NOW,
    })

    expect(collaborators.find((collaborator) => collaborator.key === 'ada')).toMatchObject({
      name: 'Ada Lovelace',
      initials: 'AL',
      role: 'write',
    })
    const stranger = collaborators.find((collaborator) => collaborator.key === 'stranger')
    expect(stranger).toMatchObject({ name: 'someone@example.com', isPresent: true })
    expect(stranger?.role).toBeUndefined()
    expect(stranger?.accountId).toBeUndefined()
  })

  it('does not pass an account id off as a name for a member this device cannot name', () => {
    const rex = buildCollaborators({ peers: [], members: roster, selfUuid: 'self', state: ACTIVE, now: NOW }).find(
      (collaborator) => collaborator.key === 'rex',
    )

    expect(rex).toMatchObject({ name: UNKNOWN_MEMBER_NAME, accountId: 'rex', initials: '?' })
    expect(UNKNOWN_MEMBER_NAME).toBe('Unknown member')
    // The id stays within reach, in the words the vault members screen uses for the same person.
    expect(unknownMemberExplanation('rex')).toBe(
      'Not in your contacts, so this device has no name for them. Account rex.',
    )
  })

  it('keeps calling someone by what they broadcast after they have left', () => {
    const rememberedNames = rememberBroadcastNames(new Map(), [peer(1, { userUuid: 'rex', name: 'rex@example.com' })])
    const rex = buildCollaborators({
      peers: [],
      members: roster,
      selfUuid: 'self',
      state: ACTIVE,
      now: NOW,
      rememberedNames,
    }).find((collaborator) => collaborator.key === 'rex')

    expect(rex).toMatchObject({ name: 'rex@example.com', initials: 'RE', isPresent: false })
    expect(rex?.accountId).toBeUndefined()
  })

  it('prefers the trusted-contact name to a remembered broadcast', () => {
    const rememberedNames = rememberBroadcastNames(new Map(), [peer(1, { userUuid: 'ada', name: 'ada@example.com' })])
    const ada = buildCollaborators({
      peers: [],
      members: roster,
      selfUuid: 'self',
      state: ACTIVE,
      now: NOW,
      rememberedNames,
    }).find((collaborator) => collaborator.key === 'ada')

    expect(ada?.name).toBe('Ada Lovelace')
  })

  it('shows one row for a person with the note open twice, as the more active of the two', () => {
    const collaborators = buildCollaborators({
      peers: [peer(1, { userUuid: 'ada', focusing: false }), peer(2, { userUuid: 'ada', typing: true })],
      members: [],
      selfUuid: 'self',
      state: ACTIVE,
      now: NOW,
    })

    expect(collaborators).toHaveLength(1)
    expect(collaborators[0]).toMatchObject({ key: 'ada', presence: 'typing' })
  })

  it('does not call a person reconnecting while another of their tabs is live', () => {
    const [ada] = buildCollaborators({
      peers: [
        peer(1, { userUuid: 'ada', reconnecting: true }),
        peer(2, { userUuid: 'ada', typing: false, focusing: false }),
      ],
      members: [],
      selfUuid: 'self',
      state: ACTIVE,
      now: NOW,
    })

    expect(ada).toMatchObject({ key: 'ada', presence: 'viewing', isPresent: true })
  })

  it("never counts the signed-in account's own other tab as a collaborator", () => {
    const collaborators = buildCollaborators({
      peers: [peer(1, { userUuid: 'self' })],
      members: [],
      selfUuid: 'self',
      state: ACTIVE,
      now: NOW,
    })

    expect(collaborators).toHaveLength(1)
    expect(collaborators[0]).toMatchObject({ isSelf: true, isPresent: false, openElsewhere: true })
  })

  it('orders those in the room by how active they are, with the reconnecting last of them', () => {
    const collaborators = buildCollaborators({
      peers: [
        peer(6, { userUuid: 'reconnecting', reconnecting: true }),
        peer(1, { userUuid: 'idle', typing: false, lastActiveAt: NOW - IDLE_AFTER_MS }),
        peer(2, { userUuid: 'here' }),
        peer(3, { userUuid: 'viewing', focusing: false }),
        peer(4, { userUuid: 'editing', focusing: true }),
        peer(5, { userUuid: 'typing', typing: true }),
      ],
      members: [{ userUuid: 'absent', contactName: 'Absent', role: 'write' }],
      selfUuid: 'self',
      state: ACTIVE,
      now: NOW,
    })

    expect(collaborators.map((collaborator) => collaborator.presence)).toEqual([
      'typing',
      'editing',
      'viewing',
      'here',
      'idle',
      'reconnecting',
      'away',
    ])
  })

  it('uses first-seen times per tab, by client id', () => {
    const firstSeenAt = new Map([
      [1, NOW - IDLE_AFTER_MS],
      [2, NOW - 1_000],
    ])
    const presenceOf = Object.fromEntries(
      buildCollaborators({
        peers: [
          peer(1, { userUuid: 'walked-away', typing: false, focusing: true }),
          peer(2, { userUuid: 'just-arrived', typing: false, focusing: true }),
        ],
        members: [],
        selfUuid: 'self',
        state: ACTIVE,
        now: NOW,
        firstSeenAt,
      }).map((collaborator) => [collaborator.key, collaborator.presence]),
    )

    expect(presenceOf).toEqual({ 'walked-away': 'idle', 'just-arrived': 'editing' })
  })

  it('lists people with a name before those this device cannot name, within a status', () => {
    const collaborators = buildCollaborators({
      peers: [],
      members: [
        { userUuid: 'aaaa-id-only', role: 'write' },
        { userUuid: 'zed', contactName: 'Zed', role: 'write' },
        { userUuid: 'amy', contactName: 'Amy', role: 'write' },
      ],
      selfUuid: 'self',
      state: ACTIVE,
      now: NOW,
    })

    expect(collaborators.map((collaborator) => collaborator.key)).toEqual(['amy', 'zed', 'aaaa-id-only'])
  })

  it('draws a peer in the colour they broadcast only when it is a plain hex colour', () => {
    const colourOf = Object.fromEntries(
      buildCollaborators({
        peers: [
          peer(1, { userUuid: 'plain', color: '#e11d48' }),
          peer(2, { userUuid: 'hostile', color: 'url(https://example.com/x.png)' }),
          peer(3, { color: '' }),
        ],
        members: [],
        selfUuid: 'self',
        state: ACTIVE,
        now: NOW,
      }).map((collaborator) => [collaborator.key, collaborator.color]),
    )

    expect(colourOf).toEqual({
      plain: '#e11d48',
      hostile: collaboratorColor('hostile'),
      'client:3': collaboratorColor('3'),
    })
  })
})

describe('how strong each status is', () => {
  const members: RosterMember[] = [
    { userUuid: 'ada', contactName: 'Ada', role: 'write' },
    { userUuid: 'rex', contactName: 'Rex', role: 'read' },
  ]
  const presenceOf = (state: CollaborationRoomState | undefined, peers: PresentPeer[] = []) =>
    Object.fromEntries(
      buildCollaborators({ peers, members, selfUuid: 'self', state, now: NOW }).map((collaborator) => [
        collaborator.key,
        collaborator.presence,
      ]),
    )

  it('says an editor is not in the note only while this client is itself in the live room', () => {
    expect(presenceOf(ACTIVE).ada).toBe('away')
    expect(presenceOf(RECONNECTING).ada).toBe('unknown')
    expect(presenceOf(PAUSED).ada).toBe('unknown')
    expect(presenceOf(undefined).ada).toBe('unknown')
  })

  it('never claims to know whether a read-only member is here, because they do not join the room', () => {
    expect(presenceOf(ACTIVE).rex).toBe('unknown')
    expect(
      unknownPresenceReason(
        buildCollaborators({ peers: [], members, selfUuid: 'self', state: ACTIVE, now: NOW }).find(
          (collaborator) => collaborator.key === 'rex',
        )!,
      ),
    ).toContain('Read-only members do not join live editing')
  })

  it('shows peers left over from a dropped room as reconnecting, not as present and active', () => {
    expect(presenceOf(RECONNECTING, [peer(1, { userUuid: 'ada', typing: true })]).ada).toBe('reconnecting')
    expect(presenceOf(PAUSED, [peer(1, { userUuid: 'ada', focusing: true })]).ada).toBe('reconnecting')
  })

  it('never calls anyone reconnecting merely because they are no longer listed', () => {
    // A collaborator's own connection dropping is something only the registry can report.
    expect(presenceOf(ACTIVE, []).ada).toBe('away')
    expect(presenceOf(ACTIVE, [peer(1, { userUuid: 'ada', reconnecting: true })]).ada).toBe('reconnecting')
  })

  it("believes the peers of a newcomer still waiting for a collaborator's copy", () => {
    expect(presenceOf(NEWCOMER, [peer(1, { userUuid: 'ada', focusing: true })]).ada).toBe('editing')
  })
})

describe('wording', () => {
  it('has a plain-word label for every presence and role', () => {
    expect(
      (['typing', 'editing', 'viewing', 'idle', 'here', 'reconnecting', 'away', 'unknown'] as const).map(presenceLabel),
    ).toEqual(['Typing', 'Editing', 'Viewing', 'Idle', 'In this note', 'Reconnecting', 'Not in this note', 'Unknown'])
    expect((['admin', 'write', 'read'] as const).map(roleLabel)).toEqual(['Admin', 'Can edit', 'Read-only'])
  })

  it('reads only the three permissions the vault can grant', () => {
    expect(['admin', 'write', 'read', 'owner', undefined, 3].map(roleFromPermission)).toEqual([
      'admin',
      'write',
      'read',
      undefined,
      undefined,
      undefined,
    ])
  })
})

describe('the session', () => {
  const STATES: Array<[string, CollaborationRoomState | undefined, FirstPreparationPhase]> = [
    ['no editor owns the note', undefined, 'quiet'],
    ['active', ACTIVE, 'quiet'],
    ['reconnecting', RECONNECTING, 'quiet'],
    ['waiting for a copy', NEWCOMER, 'visible'],
    ['first preparation, quiet', { status: { kind: 'preparing' }, hasBeenActive: false }, 'quiet'],
    ['first preparation, visible', { status: { kind: 'preparing' }, hasBeenActive: false }, 'visible'],
    ['first preparation, stood down', { status: { kind: 'preparing' }, hasBeenActive: false }, 'stood-down'],
    ['paused, never live', PAUSED, 'quiet'],
    ['unavailable after being live', { ...PAUSED, hasBeenActive: true }, 'quiet'],
    [
      'retries exhausted',
      { status: { kind: 'unavailable', reason: 'Relay refused.', retriesExhausted: true }, hasBeenActive: false },
      'quiet',
    ],
  ]

  it.each(STATES)('draws a real glyph for "%s"', (_name, state, phase) => {
    // An icon name that is a valid IconType but has no entry in the mapping renders
    // its own name as text. The chip used to do exactly that with collaborators present.
    expect(Object.keys(IconNameToSvgMapping)).toContain(describeSession(state, phase).icon)
  })

  it('speaks for itself only when there is news', () => {
    expect(STATES.map(([name, state, phase]) => [name, sessionSpeaksForItself(state, phase)])).toEqual([
      ['no editor owns the note', false],
      ['active', true],
      ['reconnecting', true],
      ['waiting for a copy', true],
      ['first preparation, quiet', false],
      ['first preparation, visible', true],
      ['first preparation, stood down', false],
      ['paused, never live', false],
      ['unavailable after being live', true],
      ['retries exhausted', true],
    ])
  })

  it('is never alarming about a state it would have kept quiet about', () => {
    for (const [, state, phase] of STATES) {
      if (!sessionSpeaksForItself(state, phase)) {
        expect(describeSession(state, phase)).toMatchObject({ tone: 'quiet', animateIcon: false })
      }
    }
  })

  it('carries the reason a paused or failed room gave', () => {
    expect(describeSession(PAUSED, 'quiet')).toMatchObject({
      heading: 'Live collaboration paused',
      detail: 'Live collaboration is offline.',
    })
    expect(describeSession({ ...PAUSED, hasBeenActive: true }, 'quiet')).toMatchObject({
      tone: 'warning',
      heading: 'Encrypted collaboration unavailable',
      detail: 'Live collaboration is offline.',
    })
  })
})

describe('the attendance sentence', () => {
  const people = (present: number, absent: number, reconnecting = 0, state = ACTIVE) =>
    buildCollaborators({
      peers: [
        ...Array.from({ length: present }, (_, index) => peer(index + 1, { userUuid: `p${index}`, name: `P${index}` })),
        ...Array.from({ length: reconnecting }, (_, index) =>
          peer(100 + index, { userUuid: `r${index}`, name: `R${index}`, reconnecting: true }),
        ),
      ],
      members: [
        { userUuid: 'self', role: 'admin' },
        ...Array.from({ length: absent }, (_, index) => ({ userUuid: `m${index}`, role: 'write' as const })),
      ],
      selfUuid: 'self',
      state,
      now: NOW,
    })

  it('always carries the count of those here', () => {
    expect(describeAttendance(people(1, 0), true)).toBe('1 collaborator here now: P0.')
    expect(describeAttendance(people(3, 2), true)).toBe('3 collaborators here now: P0, P1, P2.')
    expect(describeAttendance(people(8, 0), true)).toBe('8 collaborators here now: P0, P1, P2 and 5 more.')
  })

  it('counts those who are only reconnecting separately from those who are here', () => {
    expect(describeAttendance(people(2, 0, 1), true)).toBe('2 collaborators here now: P0, P1. 1 reconnecting: R0.')
    expect(describeAttendance(people(1, 0, 5), true)).toBe(
      '1 collaborator here now: P0. 5 reconnecting: R0, R1, R2 and 2 more.',
    )
    expect(describeAttendance(people(0, 3, 1), true)).toBe('1 collaborator reconnecting: R0.')
    expect(describeAttendance(people(0, 0, 2), true)).toBe('2 collaborators reconnecting: R0, R1.')
  })

  it('says everyone it last saw is reconnecting when it is this client that dropped', () => {
    expect(describeAttendance(people(2, 0, 0, RECONNECTING), false)).toBe('2 collaborators reconnecting: P0, P1.')
  })

  it('says nobody is here only when it can know that, and how many could be', () => {
    expect(describeAttendance(people(0, 0), true)).toBe('No one else is in this note right now.')
    expect(describeAttendance(people(0, 1), true)).toBe(
      'No one else is in this note right now. 1 other person has access to this note.',
    )
    expect(describeAttendance(people(0, 4), false)).toBe('4 other people have access to this note.')
    expect(describeAttendance(people(0, 0), false)).toBe('')
  })
})
