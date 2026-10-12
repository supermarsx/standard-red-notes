import { readFileSync } from 'fs'
import { join } from 'path'

import { IconNameToSvgMapping } from '../Icon/IconNameToSvgMapping'
import { CollaborationRoomState } from '../SuperEditor/Collaboration/CollaborationStatusRegistry'
import { PresentPeer } from '../SuperEditor/Collaboration/PresenceRegistry'
import { collaboratorColor } from '../SuperEditor/Collaboration/collaboratorColor'
import {
  buildCollaborators,
  COLLABORATORS_COLLAPSED_PREF_KEY,
  describeAttendance,
  describeSession,
  FirstPreparationPhase,
  IDLE_AFTER_MS,
  normalizeCollaboratorsCollapsed,
  peerActivity,
  presenceLabel,
  presenceNeedsClock,
  roleFromPermission,
  roleLabel,
  RosterMember,
  sessionSpeaksForItself,
  TYPING_WINDOW_MS,
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

describe('what a present peer is doing', () => {
  it('is simply "here" when the peer carries no activity fields at all', () => {
    expect(peerActivity(peer(1), NOW)).toBe('here')
    expect(presenceNeedsClock([peer(1)])).toBe(false)
  })

  it('reads focus as editing or viewing', () => {
    expect(peerActivity(peer(1, { focusing: true }), NOW)).toBe('editing')
    expect(peerActivity(peer(1, { focusing: false }), NOW)).toBe('viewing')
  })

  it('reads an explicit typing flag, which outranks focus', () => {
    expect(peerActivity(peer(1, { typing: true, focusing: false }), NOW)).toBe('typing')
    expect(peerActivity(peer(1, { typing: false, focusing: true }), NOW)).toBe('editing')
  })

  it('derives typing and idle from a last-active timestamp', () => {
    expect(peerActivity(peer(1, { lastActiveAt: NOW - 1 }), NOW)).toBe('typing')
    expect(peerActivity(peer(1, { lastActiveAt: NOW - TYPING_WINDOW_MS + 1 }), NOW)).toBe('typing')
    expect(peerActivity(peer(1, { lastActiveAt: NOW - TYPING_WINDOW_MS, focusing: true }), NOW)).toBe('editing')
    expect(peerActivity(peer(1, { lastActiveAt: NOW - IDLE_AFTER_MS + 1, focusing: false }), NOW)).toBe('viewing')
    expect(peerActivity(peer(1, { lastActiveAt: NOW - IDLE_AFTER_MS, focusing: true }), NOW)).toBe('idle')
    expect(presenceNeedsClock([peer(1), peer(2, { lastActiveAt: NOW })])).toBe(true)
  })

  it('ignores fields of the wrong type instead of guessing from them', () => {
    expect(peerActivity(peer(1, { typing: 'yes', focusing: 'true', lastActiveAt: `${NOW}` }), NOW)).toBe('here')
    expect(peerActivity(peer(1, { lastActiveAt: Number.NaN }), NOW)).toBe('here')
    // A timestamp from a clock ahead of ours is not "typing".
    expect(peerActivity(peer(1, { lastActiveAt: NOW + 60_000 }), NOW)).toBe('here')
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
  })

  it('names an absent member with no trusted contact by account id, as the rest of the app does', () => {
    const collaborators = buildCollaborators({ peers: [], members: roster, selfUuid: 'self', state: ACTIVE, now: NOW })

    expect(collaborators.find((collaborator) => collaborator.key === 'rex')?.name).toBe('rex')
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

  it('orders those in the room by how active they are', () => {
    const collaborators = buildCollaborators({
      peers: [
        peer(1, { userUuid: 'idle', lastActiveAt: NOW - IDLE_AFTER_MS }),
        peer(2, { userUuid: 'here' }),
        peer(3, { userUuid: 'viewing', focusing: false }),
        peer(4, { userUuid: 'editing', focusing: true }),
        peer(5, { userUuid: 'typing', typing: true }),
      ],
      members: [],
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
    ])
  })

  it('draws a peer in the colour they broadcast only when it is a plain hex colour', () => {
    const [plain, hostile, missing] = buildCollaborators({
      peers: [
        peer(1, { userUuid: 'a', name: 'a', color: '#e11d48' }),
        peer(2, { userUuid: 'b', name: 'b', color: 'url(https://example.com/x.png)' }),
        peer(3, { name: 'c', color: '' }),
      ],
      members: [],
      selfUuid: 'self',
      state: ACTIVE,
      now: NOW,
    })

    expect(plain.color).toBe('#e11d48')
    expect(hostile.color).toBe(collaboratorColor('b'))
    expect(missing.color).toBe(collaboratorColor('3'))
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
  const people = (present: number, absent: number) =>
    buildCollaborators({
      peers: Array.from({ length: present }, (_, index) =>
        peer(index + 1, { userUuid: `p${index}`, name: `P${index}` }),
      ),
      members: [
        { userUuid: 'self', role: 'admin' },
        ...Array.from({ length: absent }, (_, index) => ({ userUuid: `m${index}`, role: 'write' as const })),
      ],
      selfUuid: 'self',
      state: ACTIVE,
      now: NOW,
    })

  it('always carries the count of those here', () => {
    expect(describeAttendance(people(1, 0), true)).toBe('1 collaborator here now: P0.')
    expect(describeAttendance(people(3, 2), true)).toBe('3 collaborators here now: P0, P1, P2.')
    expect(describeAttendance(people(8, 0), true)).toBe('8 collaborators here now: P0, P1, P2 and 5 more.')
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
