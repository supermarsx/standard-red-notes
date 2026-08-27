import {
  describeUnmetSyncPreconditions,
  resolveUnmetSyncItemsPreconditions,
  resolveUnmetSyncPreconditions,
  resolveUnmetSyncTransportPreconditions,
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

  // -------------------------------------------------------------------------
  // The transport / SYNC_ITEMS split. An unbound gRPC syncing proxy is a
  // server-to-server dependency of ONE operation; gating the socket lane on it
  // closed the whole socket and dropped five capabilities that never touch it.
  // -------------------------------------------------------------------------
  describe('transport preconditions are separate from the SYNC_ITEMS ones', () => {
    const noGrpc = { ...satisfied, syncingServerGrpcBound: false }

    it('does not treat an unbound gRPC proxy as a transport precondition', () => {
      expect(resolveUnmetSyncTransportPreconditions(noGrpc)).toEqual([])
      expect(resolveUnmetSyncItemsPreconditions(noGrpc).map(({ code }) => code)).toEqual([
        'SYNCING_SERVER_GRPC_UNBOUND',
      ])
    })

    it('still reports every unmet condition through the combined resolver', () => {
      // The admin panel renders this list, so the gRPC condition must stay
      // visible and named -- only which of them gates WHAT has changed.
      expect(resolveUnmetSyncPreconditions(noGrpc).map(({ code }) => code)).toEqual(['SYNCING_SERVER_GRPC_UNBOUND'])
    })

    it('keeps genuine transport failures fatal to the lane', () => {
      const state = { ...satisfied, redisBound: false, connectionTokenSecretPresent: false }

      expect(resolveUnmetSyncTransportPreconditions(state).map(({ code }) => code)).toEqual([
        'WEB_SOCKET_CONNECTION_TOKEN_SECRET_MISSING',
        'REDIS_UNBOUND',
      ])
      expect(resolveUnmetSyncItemsPreconditions(state)).toEqual([])
    })

    it('partitions the codes exactly, so no condition is lost or double-counted', () => {
      const nothingSatisfied = {
        connectionTokenSecretPresent: false,
        webSocketSyncEnabled: false,
        redisBound: false,
        syncingServerGrpcBound: false,
      }
      const transport = resolveUnmetSyncTransportPreconditions(nothingSatisfied).map(({ code }) => code)
      const syncItems = resolveUnmetSyncItemsPreconditions(nothingSatisfied).map(({ code }) => code)

      expect([...transport, ...syncItems].sort()).toEqual([...SyncPreconditionCodes].sort())
      expect(transport.filter((code) => syncItems.includes(code))).toEqual([])
    })

    it('says in the remedy that an unbound proxy costs only SYNC_ITEMS', () => {
      // An operator reading this line must not conclude the socket is dead.
      const described = describeUnmetSyncPreconditions(resolveUnmetSyncItemsPreconditions(noGrpc))

      expect(described).toContain('SYNC_ITEMS ONLY')
      expect(described).toContain('SYNCING_SERVER_GRPC_URL')
    })
  })
})
