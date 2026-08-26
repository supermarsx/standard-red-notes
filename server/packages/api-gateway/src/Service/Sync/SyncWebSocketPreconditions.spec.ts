import {
  describeUnmetSyncPreconditions,
  resolveUnmetSyncPreconditions,
  SyncPreconditionCodes,
} from './SyncWebSocketPreconditions'

const satisfied = {
  connectionTokenSecretPresent: true,
  webSocketSyncEnabled: true,
  redisBound: true,
  syncingServerGrpcBound: true,
}

describe('resolveUnmetSyncPreconditions', () => {
  it('reports nothing unmet when the whole gate is satisfied', () => {
    expect(resolveUnmetSyncPreconditions(satisfied)).toEqual([])
    expect(describeUnmetSyncPreconditions([])).toBe('none')
  })

  it.each([
    ['connectionTokenSecretPresent', 'WEB_SOCKET_CONNECTION_TOKEN_SECRET_MISSING'],
    ['webSocketSyncEnabled', 'WEBSOCKET_SYNC_DISABLED_BY_CONFIGURATION'],
    ['redisBound', 'REDIS_UNBOUND'],
    ['syncingServerGrpcBound', 'SYNCING_SERVER_GRPC_UNBOUND'],
  ])('attributes a failure of %s to exactly one distinguishable code', (field, expectedCode) => {
    const resolved = resolveUnmetSyncPreconditions({ ...satisfied, [field]: false })

    expect(resolved.map(({ code }) => code)).toEqual([expectedCode])
  })

  // The whole point: an operator who fixes one condition and restarts only to
  // hit the next has learned nothing from the first log line.
  it('reports EVERY unmet condition rather than stopping at the first', () => {
    const resolved = resolveUnmetSyncPreconditions({
      connectionTokenSecretPresent: false,
      webSocketSyncEnabled: false,
      redisBound: false,
      syncingServerGrpcBound: false,
    })

    expect(resolved.map(({ code }) => code)).toEqual([...SyncPreconditionCodes])
  })

  it('names the environment variable to change in every remedy', () => {
    const resolved = resolveUnmetSyncPreconditions({
      connectionTokenSecretPresent: false,
      webSocketSyncEnabled: false,
      redisBound: false,
      syncingServerGrpcBound: false,
    })
    const described = describeUnmetSyncPreconditions(resolved)

    for (const variable of [
      'WEB_SOCKET_CONNECTION_TOKEN_SECRET',
      'WEBSOCKET_SYNC_ENABLED',
      'REDIS_URL',
      'SYNCING_SERVER_GRPC_URL',
    ]) {
      expect(described).toContain(variable)
    }
  })

  // Structural guard on the security boundary: the resolver takes booleans, so
  // there is no field a configured VALUE could travel through, and every string
  // it emits is a compile-time constant.
  it('emits only constant text, so no configured value can reach a log line', () => {
    const resolved = resolveUnmetSyncPreconditions({
      connectionTokenSecretPresent: false,
      webSocketSyncEnabled: true,
      redisBound: false,
      syncingServerGrpcBound: true,
    })

    // No connection string, URL or credential shape can appear: the resolver's
    // only inputs are booleans and its only outputs are these constants.
    expect(JSON.stringify(resolved)).not.toMatch(/redis:\/\/|https?:\/\/|@/)
  })
})
