import type { SyncDiagnosticsPayload } from './syncDiagnostics'

/**
 * Standard Red Notes: REAL admin payloads, captured from two healthy stacks built
 * from this repository, for the specs that ask "what does the pane say about a
 * deployment with nothing wrong with it".
 *
 * *** WHY THESE ARE CAPTURED AND NOT WRITTEN. *** The pane's judgements depend on
 * the topology the server reports, and every hand-written "healthy" fixture in
 * this directory is one author's idea of what a healthy server sends. Two of the
 * defects these fixtures exist to pin were invisible to such fixtures for exactly
 * that reason: the all-in-one container reports three of its services as
 * unreachable (they run in-process and have no listener to probe), and no
 * hand-written fixture ever said so.
 *
 * Captured over plain HTTP from `GET /v1/admin/sync-diagnostics` and
 * `GET /v1/admin/server-status` on:
 *
 *   - COMPOSE_GRPC — the multi-container compose stack with
 *     `SERVICE_PROXY_TYPE=grpc`, Redis, MariaDB and the queue emulator;
 *   - ALL_IN_ONE   — the single container, with nothing configured beyond its
 *     defaults.
 *
 * Presence only, as served: there is no address, secret or account identifier in
 * either. The gateway's response envelope, which carries the requesting account's
 * id, is not part of the fixture. `capturedAt` is pinned so a spec is
 * deterministic.
 *
 * Each payload is CAST to the client's type, exactly as the tab's own fetch
 * casts what comes off the wire — and for the same reason it has to be: a real
 * server sends members this build's type does not declare (a dead-letter census,
 * an advertisable-operation count), and a fixture trimmed to fit the type would
 * no longer be what a server sends.
 */

type ServerStatusFixture = {
  readonly health: unknown
  readonly services: readonly unknown[]
}

export const COMPOSE_GRPC_DIAGNOSTICS = {
  capturedAt: '2026-10-12T12:05:30.511Z',
  gate: {
    recorded: true,
    gatewayAttached: true,
    syncLaneEnabled: true,
    syncItemsAdvertised: true,
    syncItems: {
      state: 'ADVERTISED',
      cause: null,
      remedy: null,
      probe: 'READY',
    },
    unmetPreconditions: [],
    unmetCodes: [],
    files: {
      advertised: true,
      unmetCondition: null,
      remedy: null,
    },
    host: {
      unmetCondition: null,
      remedy: null,
    },
  },
  runtime: {
    processUptimeSeconds: 12643,
    authRuntimeProbe: 'answered',
    authProcessUptimeSeconds: 12663,
    cookieSecure: false,
    cookiePartitioned: false,
    e2eTesting: false,
  },
  datastore: {
    connectionState: 'connected',
    writeProbe: 'accepted',
    migrationsApplied: true,
    pendingMigrations: 0,
    poolInUse: 0,
    poolSize: 20,
    readRoundTripMs: 1,
    writeRoundTripMs: 0,
  },
  queues: {
    separation: 'own-prefixed-queue',
    consumerCount: 5,
    deadLetterRows: 0,
    deadLetterRequeueable: true,
  },
  admission: {
    originAdmitted: true,
    allowedOriginCount: 1,
    allowsSameOrigin: true,
    liveSockets: 2,
    ticketsIssued: 13,
    ticketsRefused: 0,
    handshakeRejected: 0,
    advertisableOperationCount: 6,
    rejections: {
      originNotAllowed: 0,
      queryStringNotPermitted: 0,
      unavailable: 0,
    },
  },
  deployment: {
    recorded: true,
    mode: 'self-hosted',
    serviceProxySetting: 'grpc',
    serviceProxyDecision: 'operator',
    internalGrpcSecretState: 'minted-persisted',
    boundServiceProxy: 'grpc',
    cacheSetting: 'redis',
    syncSwitchSetting: 'true',
    grpcSyncingProxyBound: true,
    grpcProxyBindableInThisMode: true,
    redisBound: true,
    presence: {
      WEB_SOCKET_CONNECTION_TOKEN_SECRET: true,
      WEBSOCKET_SYNC_ALLOWED_ORIGINS: false,
      PUBLIC_URL: false,
      WEBSOCKET_GATEWAY_INTERNAL_SECRET: true,
      REDIS_URL: true,
      REDIS_HOST: true,
      REDIS_PORT: true,
      SYNCING_SERVER_GRPC_URL: true,
      AUTH_SERVER_GRPC_URL: true,
      SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET: true,
      SYNCING_SERVER_JS_URL: true,
      WEBSOCKET_SYNC_FILES_URL: true,
      FILES_SERVER_PROBE_URL: false,
      FILES_SERVER_URL: true,
      VALET_TOKEN_SECRET: true,
      AUTH_JWT_SECRET: true,
      SQS_QUEUE_URL: true,
      API_GATEWAY_SQS_QUEUE_URL: true,
      SNS_TOPIC_ARN: false,
      SRN_DEPLOY_REVISION: true,
      SRN_DEPLOY_VERSION: false,
    },
  },
  transportFallback: {
    observed: false,
    everDegraded: false,
    lanes: {
      'session-validation': {
        degradedCalls: 0,
        refusedCalls: 0,
        lastFailureClass: null,
        lastFailureAgeMs: null,
      },
      'items-sync': {
        degradedCalls: 0,
        refusedCalls: 0,
        lastFailureClass: null,
        lastFailureAgeMs: null,
      },
    },
  },
  live: {
    capabilities: [
      {
        id: 'ws-sync',
        version: 1,
        endpoint: '/sockets/sync',
      },
    ],
    unavailabilityReasons: [],
    realtime: {
      attached: true,
      pushBridge: 'redis',
      pushBridgeReady: true,
      sqsConsumerRunning: true,
      collaborationRelayHealthy: true,
      syncLane: 'up',
      pushesDispatched: 10,
    },
    ticketAvailable: true,
  },
  protocol: {
    version: 1,
    serverOperations: [
      'SYNC_ITEMS',
      'AUTHORIZE_COLLABORATION',
      'API_RPC',
      'STREAM_ASSISTANT',
      'INVITE_EVENTS',
      'FILES_V1',
    ],
  },
} as unknown as SyncDiagnosticsPayload

export const COMPOSE_GRPC_SERVER_STATUS: ServerStatusFixture = {
  health: {
    gateway: {
      redis: true,
    },
    auth: {
      reachable: true,
      status: 'ready',
      checks: {
        db: true,
        redis: true,
      },
      responseTimeMs: 5,
    },
  },
  services: [
    {
      name: 'api-gateway',
      reachable: true,
      status: 'ok',
      probeDepth: 'unknown',
    },
    {
      name: 'auth',
      reachable: true,
      status: 'ok',
      responseTimeMs: 5,
      probeDepth: 'readiness',
    },
    {
      name: 'syncing-server',
      reachable: true,
      status: 'ok',
      responseTimeMs: 21,
      probeDepth: 'readiness',
    },
    {
      name: 'files',
      reachable: true,
      status: 'ok',
      responseTimeMs: 21,
      probeDepth: 'readiness',
    },
    {
      name: 'revisions',
      reachable: true,
      status: 'ok',
      responseTimeMs: 20,
      probeDepth: 'readiness',
    },
    {
      name: 'websocket-gateway',
      reachable: true,
      status: 'ok',
      responseTimeMs: 227,
      probeDepth: 'readiness',
    },
  ],
}

export const ALL_IN_ONE_DIAGNOSTICS = {
  capturedAt: '2026-10-12T12:05:30.511Z',
  gate: {
    recorded: true,
    gatewayAttached: true,
    syncLaneEnabled: true,
    syncItemsAdvertised: true,
    syncItems: {
      state: 'ADVERTISED',
      cause: null,
      remedy: null,
      probe: 'READY',
    },
    unmetPreconditions: [],
    unmetCodes: [],
    files: {
      advertised: true,
      unmetCondition: null,
      remedy: null,
    },
    host: {
      unmetCondition: null,
      remedy: null,
    },
  },
  runtime: {
    processUptimeSeconds: 12626,
    authRuntimeProbe: 'answered',
    authProcessUptimeSeconds: 12626,
    cookieSecure: false,
    cookiePartitioned: false,
    e2eTesting: false,
  },
  datastore: {
    connectionState: 'connected',
    writeProbe: 'accepted',
    migrationsApplied: true,
    pendingMigrations: 0,
    readRoundTripMs: 0,
    writeRoundTripMs: 0,
  },
  queues: {
    separation: 'in-process-fan-out',
    deadLetterRows: 0,
    deadLetterRequeueable: true,
  },
  admission: {
    originAdmitted: true,
    allowedOriginCount: 1,
    allowsSameOrigin: true,
    liveSockets: 2,
    ticketsIssued: 7,
    ticketsRefused: 0,
    handshakeRejected: 0,
    advertisableOperationCount: 6,
    rejections: {
      originNotAllowed: 0,
      queryStringNotPermitted: 0,
      unavailable: 0,
    },
  },
  deployment: {
    recorded: true,
    mode: 'home-server',
    serviceProxySetting: 'unset',
    serviceProxyDecision: 'unset',
    internalGrpcSecretState: 'unset',
    boundServiceProxy: 'direct-call',
    cacheSetting: 'memory',
    syncSwitchSetting: 'true',
    grpcSyncingProxyBound: false,
    grpcProxyBindableInThisMode: false,
    redisBound: false,
    presence: {
      WEB_SOCKET_CONNECTION_TOKEN_SECRET: true,
      WEBSOCKET_SYNC_ALLOWED_ORIGINS: false,
      PUBLIC_URL: false,
      WEBSOCKET_GATEWAY_INTERNAL_SECRET: true,
      REDIS_URL: true,
      REDIS_HOST: false,
      REDIS_PORT: true,
      SYNCING_SERVER_GRPC_URL: false,
      AUTH_SERVER_GRPC_URL: false,
      SYNCING_SERVER_INTERNAL_GRPC_AUTH_SECRET: false,
      SYNCING_SERVER_JS_URL: false,
      WEBSOCKET_SYNC_FILES_URL: false,
      FILES_SERVER_PROBE_URL: false,
      FILES_SERVER_URL: true,
      VALET_TOKEN_SECRET: true,
      AUTH_JWT_SECRET: true,
      SQS_QUEUE_URL: false,
      API_GATEWAY_SQS_QUEUE_URL: false,
      SNS_TOPIC_ARN: false,
      SRN_DEPLOY_REVISION: true,
      SRN_DEPLOY_VERSION: false,
    },
  },
  transportFallback: {
    observed: false,
    everDegraded: false,
    lanes: {
      'session-validation': {
        degradedCalls: 0,
        refusedCalls: 0,
        lastFailureClass: null,
        lastFailureAgeMs: null,
      },
      'items-sync': {
        degradedCalls: 0,
        refusedCalls: 0,
        lastFailureClass: null,
        lastFailureAgeMs: null,
      },
    },
  },
  live: {
    capabilities: [
      {
        id: 'ws-sync',
        version: 1,
        endpoint: '/sockets/sync',
      },
    ],
    unavailabilityReasons: [],
    realtime: {
      attached: true,
      pushBridge: 'in-process',
      pushBridgeReady: true,
      sqsConsumerRunning: false,
      collaborationRelayHealthy: true,
      syncLane: 'up',
      pushesDispatched: 11,
    },
    ticketAvailable: true,
  },
  protocol: {
    version: 1,
    serverOperations: [
      'SYNC_ITEMS',
      'AUTHORIZE_COLLABORATION',
      'API_RPC',
      'STREAM_ASSISTANT',
      'INVITE_EVENTS',
      'FILES_V1',
    ],
  },
} as unknown as SyncDiagnosticsPayload

export const ALL_IN_ONE_SERVER_STATUS: ServerStatusFixture = {
  health: {
    gateway: {
      redis: null,
    },
    auth: {
      reachable: true,
      status: 'ready',
      checks: {
        db: true,
        redis: true,
      },
      responseTimeMs: 4,
    },
  },
  services: [
    {
      name: 'api-gateway',
      reachable: true,
      status: 'ok',
      probeDepth: 'unknown',
    },
    {
      name: 'auth',
      reachable: true,
      status: 'ok',
      responseTimeMs: 4,
      probeDepth: 'readiness',
    },
    {
      name: 'syncing-server',
      reachable: false,
      status: 'down',
      detail: 'unreachable',
      responseTimeMs: 9,
      probeDepth: 'unknown',
    },
    {
      name: 'files',
      reachable: false,
      status: 'down',
      detail: 'unreachable',
      responseTimeMs: 7,
      probeDepth: 'unknown',
    },
    {
      name: 'revisions',
      reachable: false,
      status: 'down',
      detail: 'unreachable',
      responseTimeMs: 7,
      probeDepth: 'unknown',
    },
    {
      name: 'websocket-gateway',
      reachable: false,
      status: 'unknown',
      detail: 'not configured',
      probeDepth: 'unknown',
    },
  ],
}

/** Every operation both stacks negotiated on the capturing client's own socket. */
export const NEGOTIATED_OPERATIONS = [
  'SYNC_ITEMS',
  'AUTHORIZE_COLLABORATION',
  'API_RPC',
  'STREAM_ASSISTANT',
  'INVITE_EVENTS',
  'FILES_V1',
] as const
