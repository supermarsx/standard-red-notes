import { buildEnvironmentGroups, describeTopology } from './diagnosticEnvironment'
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

const rowFor = (groups: ReturnType<typeof buildEnvironmentGroups>, key: string) =>
  groups.flatMap((group) => group.rows).find((row) => row.key === key)

describe('buildEnvironmentGroups', () => {
  it('marks a set-but-unread variable as inert and warns about it', () => {
    const groups = buildEnvironmentGroups(
      topology({ serviceProxySetting: 'unset', presence: { SYNCING_SERVER_GRPC_URL: true } }),
    )

    const row = rowFor(groups, 'SYNCING_SERVER_GRPC_URL')
    expect(row?.relevance).toBe('inert')
    expect(row?.tone).toBe('warn')
    expect(row?.note).toContain('Set, and NOT read')
  })

  it('does not warn about an inert variable that is not set — that state is simply correct', () => {
    const groups = buildEnvironmentGroups(topology({ presence: { SYNCING_SERVER_GRPC_URL: false } }))

    expect(rowFor(groups, 'SYNCING_SERVER_GRPC_URL')?.tone).toBe('neutral')
  })

  it('marks the gRPC address variables required once the branch is selected', () => {
    const groups = buildEnvironmentGroups(
      topology({ serviceProxySetting: 'grpc', presence: { AUTH_SERVER_GRPC_URL: false } }),
    )

    const row = rowFor(groups, 'AUTH_SERVER_GRPC_URL')
    expect(row?.relevance).toBe('required')
    expect(row?.note).toContain('will not start without it')
  })

  it('flags REDIS_HOST as inert where the gateway binds Redis from REDIS_URL', () => {
    const groups = buildEnvironmentGroups(topology({ presence: { REDIS_HOST: true, REDIS_URL: false } }))

    expect(rowFor(groups, 'REDIS_HOST')?.relevance).toBe('inert')
    expect(rowFor(groups, 'REDIS_URL')?.relevance).toBe('required')
  })

  it('inverts that judgement in home-server mode, where REDIS_HOST is the one that counts', () => {
    const groups = buildEnvironmentGroups(
      topology({ mode: 'home-server', presence: { REDIS_HOST: true, REDIS_URL: true } }),
    )

    expect(rowFor(groups, 'REDIS_HOST')?.relevance).toBe('required')
    expect(rowFor(groups, 'REDIS_URL')?.relevance).toBe('inert')
  })

  it('marks REDIS_URL inert while CACHE_TYPE selects the memory cache', () => {
    const groups = buildEnvironmentGroups(topology({ cacheSetting: 'memory', presence: { REDIS_URL: true } }))

    expect(rowFor(groups, 'REDIS_URL')?.note).toContain('CACHE_TYPE=memory')
  })

  it('makes no relevance claim at all when the topology was not recorded', () => {
    const groups = buildEnvironmentGroups({ recorded: false, presence: { SYNCING_SERVER_GRPC_URL: true } })

    const row = rowFor(groups, 'SYNCING_SERVER_GRPC_URL')
    expect(row?.relevance).toBe('unknown')
    expect(row?.note).toBe('')
  })

  it('reports nothing rather than empty groups when the server sends no presence block', () => {
    expect(buildEnvironmentGroups(undefined)).toEqual([])
  })

  it('surfaces a key a newer server reports rather than silently dropping it', () => {
    const groups = buildEnvironmentGroups(topology({ presence: { SOME_FUTURE_VARIABLE: true } }))

    expect(rowFor(groups, 'SOME_FUTURE_VARIABLE')?.present).toBe(true)
    expect(groups.some((group) => group.title === 'Reported by a newer server')).toBe(true)
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
