import { buildEnvironmentPresence, DECLARED_ENV_KEYS, isKnownEnvKey, describeTopology } from './diagnosticEnvironment'
import { ENV_NAME } from './diagnosticsSections'
import type { DeploymentTopology } from './diagnosticRemedies'

const topology = (overrides: Partial<DeploymentTopology> = {}): DeploymentTopology => ({
  recorded: true,
  mode: 'unset',
  serviceProxySetting: 'unset',
  boundServiceProxy: 'http',
  cacheSetting: 'redis',
  syncSwitchSetting: 'unset',
  grpcSyncingProxyBound: false,
  grpcProxyBindableInThisMode: true,
  redisBound: true,
  presence: {},
  ...overrides,
})

const rowFor = (presence: ReturnType<typeof buildEnvironmentPresence>, key: string) =>
  presence.groups.flatMap((group) => group.rows).find((row) => row.key === key)

describe('buildEnvironmentPresence', () => {
  it('marks a set-but-unread variable as inert and warns about it', () => {
    const presence = buildEnvironmentPresence(
      topology({ serviceProxySetting: 'unset', presence: { SYNCING_SERVER_GRPC_URL: true } }),
    )

    const row = rowFor(presence, 'SYNCING_SERVER_GRPC_URL')
    expect(row?.relevance).toBe('inert')
    expect(row?.tone).toBe('warn')
    expect(row?.note).toContain('Set, and NOT read')
  })

  it('does not warn about an inert variable that is not set — that state is simply correct', () => {
    const presence = buildEnvironmentPresence(topology({ presence: { SYNCING_SERVER_GRPC_URL: false } }))

    expect(rowFor(presence, 'SYNCING_SERVER_GRPC_URL')?.tone).toBe('neutral')
  })

  it('marks the gRPC address variables required once the branch is selected', () => {
    const presence = buildEnvironmentPresence(
      topology({ serviceProxySetting: 'grpc', presence: { AUTH_SERVER_GRPC_URL: false } }),
    )

    const row = rowFor(presence, 'AUTH_SERVER_GRPC_URL')
    expect(row?.relevance).toBe('required')
    expect(row?.note).toContain('will not start without it')
  })

  it('flags REDIS_HOST as inert where the gateway binds Redis from REDIS_URL', () => {
    const presence = buildEnvironmentPresence(topology({ presence: { REDIS_HOST: true, REDIS_URL: false } }))

    expect(rowFor(presence, 'REDIS_HOST')?.relevance).toBe('inert')
    expect(rowFor(presence, 'REDIS_URL')?.relevance).toBe('required')
  })

  it('inverts that judgement in home-server mode, where REDIS_HOST is the one that counts', () => {
    const presence = buildEnvironmentPresence(
      topology({ mode: 'home-server', presence: { REDIS_HOST: true, REDIS_URL: true } }),
    )

    expect(rowFor(presence, 'REDIS_HOST')?.relevance).toBe('required')
    expect(rowFor(presence, 'REDIS_URL')?.relevance).toBe('inert')
  })

  it('marks REDIS_URL inert while CACHE_TYPE selects the memory cache', () => {
    const presence = buildEnvironmentPresence(topology({ cacheSetting: 'memory', presence: { REDIS_URL: true } }))

    expect(rowFor(presence, 'REDIS_URL')?.note).toContain('CACHE_TYPE=memory')
  })

  it('makes no relevance claim at all when the topology was not recorded', () => {
    const presence = buildEnvironmentPresence({ recorded: false, presence: { SYNCING_SERVER_GRPC_URL: true } })

    const row = rowFor(presence, 'SYNCING_SERVER_GRPC_URL')
    expect(row?.relevance).toBe('unknown')
    expect(row?.note).toBe('')
  })

  it('reports nothing rather than empty groups when the server sends no presence block', () => {
    expect(buildEnvironmentPresence(undefined)).toEqual({ groups: [], unrecognised: 0, reported: false })
  })

  /**
   * *** A PRESENCE KEY IS SERVER-CONTROLLED TEXT. ***
   *
   * The keys of an object off the wire are as much its content as its values,
   * and this view used to put one it had never heard of straight into a row
   * through `sanitizeServerCopy` — a denylist that says in its own comment that
   * it cannot catch a secret with no structure. Both consumers printed the
   * result: the copyable report's `## Configuration presence` and the Environment
   * section's rows.
   *
   * Three plants, because two of the three distinguish the member check from the
   * mechanisms that only look like one:
   *
   *   - ADDRESS-SHAPED. The denylist catches this one, which is why planting only
   *     this would pass against the defect.
   *   - OPAQUE. Nothing for a pattern to match. This is the class a denylist
   *     structurally cannot see, and it printed verbatim.
   *   - UPPER SNAKE CASE, i.e. shaped exactly like a variable name. `safeEnvName`
   *     admits this one BY SHAPE, so the section's label floor passed it through
   *     while refusing the other two. Shape is not membership.
   *
   * Built from markers rather than plausible prose so no fragment collides with
   * this build's own copy, and asserted by head, middle AND tail: a peer's
   * hand-picked fragments all landed past a truncation earlier tonight, so the
   * leak that remained was of bytes nobody asserted on.
   */
  describe('a key the server chose', () => {
    const ADDRESS_SHAPED = 'syncing.internal.example:50051'
    const OPAQUE = 'srnenvleakhead-99999999999999999999-srnenvleakmid-99999999999999999999-srnenvleaktail'
    const ENV_SHAPED = 'SRNENVLEAKHEAD_999999999_SRNENVLEAKMID_999999999_SRNENVLEAKTAIL'

    /** 20-character windows from the start, the middle and the end. */
    const windows = (value: string): string[] => [
      value.slice(0, 20),
      value.slice(Math.max(0, Math.floor(value.length / 2) - 10), Math.floor(value.length / 2) + 10),
      value.slice(-20),
      value,
    ]

    const planted = () =>
      buildEnvironmentPresence(
        topology({
          presence: {
            REDIS_URL: true,
            [ADDRESS_SHAPED]: true,
            [OPAQUE]: true,
            [ENV_SHAPED]: false,
          },
        }),
      )

    /**
     * The fixture's own controls. Each plant has to be the CLASS it is here to
     * represent, or the assertions below pass for the wrong reason: the third
     * must actually be admissible to the shape floor, and the first two must
     * actually be refused by it, or none of them tells the member check apart
     * from a scrub.
     */
    it('plants one key the name floor admits and two it refuses', () => {
      expect(ENV_SHAPED).toMatch(ENV_NAME)
      expect(OPAQUE).not.toMatch(ENV_NAME)
      expect(ADDRESS_SHAPED).not.toMatch(ENV_NAME)
    })

    it('counts it and names none of it', () => {
      const serialised = JSON.stringify(planted())

      for (const value of [ADDRESS_SHAPED, OPAQUE, ENV_SHAPED]) {
        for (const fragment of windows(value)) {
          expect(serialised).not.toContain(fragment)
        }
      }
      // Withheld because it was never printed, not because a pattern matched its
      // shape. The presence of this sentinel would mean the denylist had been
      // reinstated as the defence, which is the defect rather than the fix.
      expect(serialised).not.toContain('[address withheld]')
      expect(planted().unrecognised).toBe(3)
    })

    it('still names every variable this build declares, so the count is read against a list', () => {
      expect(rowFor(planted(), 'REDIS_URL')?.present).toBe(true)
    })

    it('says the server reported something, which is not the same as reporting nothing', () => {
      expect(planted().reported).toBe(true)
      // A presence block carrying ONLY keys this build cannot name still counts
      // as reported: "nothing was reported" is a claim about the server, and
      // making it here would be false.
      const unknownOnly = buildEnvironmentPresence(topology({ presence: { [OPAQUE]: true } }))
      expect(unknownOnly).toEqual({ groups: [], unrecognised: 1, reported: true })
    })

    it('counts zero when everything reported is a variable this build declares', () => {
      expect(buildEnvironmentPresence(topology({ presence: { REDIS_URL: true } })).unrecognised).toBe(0)
    })
  })

  /**
   * The runtime half of the member check, exercised directly: the type stops a
   * wire key reaching a row, and this is what still stops it when a future cast
   * erases the type.
   */
  it('admits a declared variable name and refuses one off the wire', () => {
    expect(isKnownEnvKey('REDIS_URL')).toBe(true)
    expect(isKnownEnvKey('SOME_FUTURE_VARIABLE')).toBe(false)
    expect(isKnownEnvKey('redis_url')).toBe(false)
  })

  /**
   * `safeEnvName` is the floor under every label this section prints. A declared
   * key that fell outside the project's own naming shape would be refused by it
   * and would read as a withheld value — a real variable rendered as if it were a
   * secret — so the two rules are pinned together here rather than assumed.
   */
  it('declares only keys the name floor admits', () => {
    const declared = buildEnvironmentPresence(
      topology({ presence: Object.fromEntries(DECLARED_ENV_KEYS.map((key) => [key, true])) }),
    )

    expect(DECLARED_ENV_KEYS.length).toBeGreaterThan(15)
    for (const key of DECLARED_ENV_KEYS) {
      expect(key).toMatch(ENV_NAME)
    }
    expect(declared.unrecognised).toBe(0)
    expect(declared.groups.flatMap((group) => group.rows)).toHaveLength(DECLARED_ENV_KEYS.length)
  })
})

describe('describeTopology', () => {
  it('says plainly that nothing was reported, so the operator discounts the remedies', () => {
    const facts = describeTopology(undefined)

    expect(facts).toHaveLength(1)
    expect(facts[0].note).toContain('may not apply here')
  })

  it('explains that the gRPC proxy cannot be bound at all in home-server mode', () => {
    const facts = describeTopology(topology({ mode: 'home-server', grpcProxyBindableInThisMode: false }))

    const grpc = facts.find((fact) => fact.label === 'gRPC syncing proxy bound')
    expect(grpc?.note).toContain('no environment variable will change this')
  })

  it('explains why "Redis bound: no" is expected in home-server mode rather than alarming', () => {
    const facts = describeTopology(topology({ mode: 'home-server', redisBound: false }))

    expect(facts.find((fact) => fact.label === 'Redis bound')?.note).toContain('is not the gate')
  })

  it('carries only names, enums and booleans', () => {
    const serialized = JSON.stringify(describeTopology(topology({ mode: 'self-hosted' })))

    expect(serialized).not.toMatch(/https?:\/\//)
    expect(serialized).not.toMatch(/\d{1,3}(\.\d{1,3}){3}/)
  })
})
