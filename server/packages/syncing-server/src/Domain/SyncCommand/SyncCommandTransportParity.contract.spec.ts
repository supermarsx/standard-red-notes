/**
 * Standard Red Notes — CROSS-PACKAGE CONTRACT: are gRPC and HTTP interchangeable
 * for ONE durable sync command?
 *
 * WHY THIS FILE EXISTS
 *
 * `GRPCServiceProxy.fallBackFromSyncGRPC` (api-gateway) may re-deliver a FAILED
 * `items/sync` gRPC attempt over HTTP when — and only when —
 * `GRPCSyncingServerServiceProxy.durableCommandReplayKeyPresent` says the call
 * carries a durable command key. That permission rests entirely on a claim about
 * the OTHER package: that `BaseItemsController.sync` and `SyncingServer.syncItems`
 * resolve the same command onto the same ledger row in the same database, so the
 * second delivery REPLAYS instead of applying the user's note mutation twice.
 *
 * Nothing automated pinned that claim. Each package's own specs stub the other
 * side: `GRPCServiceProxy.spec.ts` stubs Axios and never reaches a syncing
 * server; `BaseItemsController.sync-command.spec.ts` stubs `ExecuteSyncCommand`
 * and never sees a gateway. The claim lived only in a prose comment.
 *
 * WHAT IS REAL HERE, AND WHY THAT IS THE POINT
 *
 * REAL: one sqlite `DataSource`, one `ExecuteSyncCommand`, one
 * `SyncCommandTransactionContext`, the real `TypeORMSyncCommandRepository`, the
 * real `SyncingServer.syncItems` (gRPC entry), the real `BaseItemsController.sync`
 * (HTTP entry), the real `GRPCSyncingServerServiceProxy` (the gateway's gRPC leg
 * AND the fallback authoriser), the real request/response gRPC mappers on both
 * sides, and the real `InternalGrpcServiceAuth` signing/verification with a
 * shared secret.
 *
 * STUBBED: only `SyncItems` (the item-write use case) and the sync-response
 * factory. `SyncItems` is stubbed BECAUSE it is the observation point — the
 * double-apply assertion in every test below is `syncItems.execute` having been
 * called exactly ONCE across two transports. Stubbing the ledger, the digest
 * canonicalisation or either route handler would make this file worthless, so
 * none of them is stubbed.
 *
 * `SyncItems`' INPUT mapping is deliberately not compared across transports: an
 * idempotency ledger makes the FIRST result authoritative, so a replay returns
 * the stored response whatever the second caller would have computed. What must
 * agree is the ledger KEY, the DIGEST and the metadata RESOLUTION — those are
 * what these tests pin.
 */
import * as grpc from '@grpc/grpc-js'
import { Status } from '@grpc/grpc-js/build/src/constants'
import { Result } from '@standardnotes/domain-core'
import { SyncRequest, SyncResponse } from '@standardnotes/grpc'
import { INTERNAL_GRPC_AUTH_METADATA, InternalGrpcServiceAuth } from '@standardnotes/security'
import { Request, Response } from 'express'
import { results } from 'inversify-express-utils'
import { DataSource } from 'typeorm'
import { Logger } from 'winston'

/*
 * The api-gateway half. Imported by path because api-gateway is not a dependency
 * of syncing-server (nor the reverse) — only `home-server` depends on both, and
 * it has neither typeorm nor better-sqlite3, so the real ledger cannot be built
 * there. A contract test that cannot build the real ledger is not worth having,
 * so the test lives beside the ledger and reaches for the gateway's two
 * fallback-deciding modules instead.
 */
import { GRPCSyncingServerServiceProxy } from '../../../../api-gateway/src/Service/gRPC/GRPCSyncingServerServiceProxy'
import {
  GRPC_FALLBACK_ELIGIBILITY,
  syncPayloadWritesNothing,
  type GrpcCallReplaySafety,
} from '../../../../api-gateway/src/Service/gRPC/GrpcTransportFallback'
import { SyncRequestGRPCMapper } from '../../../../api-gateway/src/Mapping/Sync/GRPC/SyncRequestGRPCMapper'
import { SyncResponseGRPCMapper as GatewaySyncResponseGRPCMapper } from '../../../../api-gateway/src/Mapping/Sync/GRPC/SyncResponseGRPCMapper'
import {
  canonicalSyncCommandJson,
  computeSyncCommandDigest as gatewayComputeSyncCommandDigest,
  logicalSyncCommandPayload,
} from '../../../../api-gateway/src/Service/Sync/SyncCommandDigest'

/* The syncing-server half. */
import { BaseItemsController } from '../../Infra/InversifyExpressUtils/Base/BaseItemsController'
import { SyncingServer } from '../../Infra/gRPC/SyncingServer'
import { SyncResponseGRPCMapper as ServerSyncResponseGRPCMapper } from '../../Mapping/gRPC/SyncResponseGRPCMapper'
import { SyncCommandTransactionContext } from '../../Infra/TypeORM/SyncCommandTransactionContext'
import { TypeORMSyncCommand } from '../../Infra/TypeORM/TypeORMSyncCommand'
import { TypeORMSyncCommandOutbox } from '../../Infra/TypeORM/TypeORMSyncCommandOutbox'
import { TypeORMSyncCommandRepository } from '../../Infra/TypeORM/TypeORMSyncCommandRepository'
import { TypeORMSyncCommandOutboxRepository } from '../../Infra/TypeORM/TypeORMSyncCommandOutboxRepository'
import { ExecuteSyncCommand } from './ExecuteSyncCommand'
import { SyncCommandOutboxDispatcher } from './SyncCommandOutboxDispatcher'
import { canonicalJson, computeSyncCommandDigest as serverComputeSyncCommandDigest } from './SyncCommandTypes'

/* A test fixture, not a deployment value: >= 32 bytes so `InternalGrpcServiceAuth.ready()` is true. */
const SHARED_INTERNAL_GRPC_SECRET = 'cross-transport-contract-fixture-secret-0123456789'

const USER_UUID = '11111111-1111-4111-8111-111111111111'
const SESSION_UUID = '22222222-2222-4222-8222-222222222222'

type JsonObject = Record<string, unknown>

/** A sync body that WRITES — the only kind whose double delivery costs a user a duplicated note. */
const mutatingBody = (): JsonObject => ({
  api: '20200115',
  sync_token: 'sync-token-1',
  items: [
    {
      uuid: '33333333-3333-4333-8333-333333333333',
      content: '004:ciphertext-v2',
      content_type: 'Note',
      deleted: false,
      enc_item_key: '004:enc-item-key',
      auth_hash: null,
      updated_at: '2026-10-03T00:00:00.000Z',
      updated_at_timestamp: 1_767_312_000_000_000,
    },
  ],
})

const modernResponseTemplate = () => ({
  retrieved_items: [],
  saved_items: [],
  conflicts: [],
  sync_token: 'stored-sync-token',
  messages: [],
  shared_vaults: [],
  shared_vault_invites: [],
  notifications: [],
})

describe('durable sync command transport parity (api-gateway <-> syncing-server)', () => {
  let dataSource: DataSource
  let transactionContext: SyncCommandTransactionContext
  let dispatcher: SyncCommandOutboxDispatcher
  let executeSyncCommand: ExecuteSyncCommand
  let syncItems: { execute: jest.Mock }
  let checkForTrafficAbuse: { execute: jest.Mock }
  let logger: jest.Mocked<Logger>
  let setHeader: jest.Mock

  let syncingServer: SyncingServer
  let httpController: BaseItemsController
  let gatewayProxy: GRPCSyncingServerServiceProxy

  /** Set to make the gRPC transport report UNAVAILABLE *after* the server already applied the call. */
  let dropGrpcAfterServerAnswers = false
  /** Set to drop `x-sync-canonical-digest` on the wire, forcing the server's reconstruction branch. */
  let stripCanonicalDigestMetadata = false

  const expressResponse = (): Response =>
    ({
      locals: {
        user: { uuid: USER_UUID },
        session: { uuid: SESSION_UUID },
        readOnlyAccess: false,
        isFreeUser: false,
        hasContentLimit: false,
      },
      setHeader,
    }) as unknown as Response

  const expressRequest = (headers: Record<string, string | string[]> = {}, body: JsonObject = {}): Request =>
    ({ headers: { 'x-snjs-version': '2.200.0', ...headers }, body, params: {} }) as unknown as Request

  /**
   * Exactly what `GRPCServiceProxy.getServerResponse` puts on the wire for the
   * HTTP hop — every inbound header except host/content-length, plus the SAME
   * payload object — and then what the syncing server's JSON body parser hands
   * its controller. The `JSON.parse(JSON.stringify(...))` is not decoration: the
   * digest claim is a claim about the body AFTER a JSON round trip.
   */
  const forwardedOverHttp = (request: Request, payload: JsonObject): Request => {
    const headers: Record<string, string | string[]> = {}
    for (const name of Object.keys(request.headers)) {
      headers[name] = request.headers[name] as string
    }
    delete headers.host
    delete headers['content-length']

    return { headers, body: JSON.parse(JSON.stringify(payload)) as JsonObject, params: {} } as unknown as Request
  }

  const commandRows = (): Promise<TypeORMSyncCommand[]> =>
    dataSource.getRepository(TypeORMSyncCommand).find({ order: { commandId: 'ASC' } })

  beforeEach(async () => {
    dropGrpcAfterServerAnswers = false
    stripCanonicalDigestMetadata = false

    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [TypeORMSyncCommand, TypeORMSyncCommandOutbox],
      synchronize: true,
    })
    await dataSource.initialize()

    transactionContext = new SyncCommandTransactionContext()
    const commandRepository = new TypeORMSyncCommandRepository(
      dataSource.getRepository(TypeORMSyncCommand),
      transactionContext,
    )
    const outboxRepository = new TypeORMSyncCommandOutboxRepository(
      dataSource.getRepository(TypeORMSyncCommandOutbox),
      transactionContext,
    )
    logger = {
      debug: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
    } as unknown as jest.Mocked<Logger>
    dispatcher = new SyncCommandOutboxDispatcher(
      outboxRepository,
      { publish: jest.fn().mockResolvedValue(undefined) },
      logger,
      1_000,
    )
    executeSyncCommand = new ExecuteSyncCommand(dataSource, transactionContext, commandRepository, dispatcher, 60_000)

    syncItems = { execute: jest.fn().mockResolvedValue(Result.ok({})) }
    checkForTrafficAbuse = { execute: jest.fn().mockResolvedValue(Result.ok()) }
    setHeader = jest.fn()
    const syncResponseFactoryResolver = {
      resolveSyncResponseFactoryVersion: () => ({
        createResponse: jest.fn().mockImplementation(async () => modernResponseTemplate()),
      }),
    }

    syncingServer = new SyncingServer(
      syncItems as never,
      syncResponseFactoryResolver as never,
      new ServerSyncResponseGRPCMapper(),
      checkForTrafficAbuse as never,
      false,
      5,
      100,
      50,
      10_000,
      5_000,
      5,
      logger,
      executeSyncCommand,
      undefined,
      SHARED_INTERNAL_GRPC_SECRET,
    )

    httpController = new BaseItemsController(
      checkForTrafficAbuse as never,
      syncItems as never,
      {} as never,
      {} as never,
      {} as never,
      syncResponseFactoryResolver as never,
      logger,
      false,
      5,
      100,
      50,
      10_000,
      5_000,
      5,
      undefined,
      undefined,
      executeSyncCommand,
      undefined,
    )

    /*
     * An in-process gRPC client: the gateway's real `sync()` builds the real
     * SyncRequest and the real signed metadata, and this hands them straight to
     * the real server handler. No stub sits between the two transports.
     */
    const syncingClient = {
      syncItems: (
        grpcRequest: SyncRequest,
        metadata: grpc.Metadata,
        callback: (error: grpc.ServiceError | null, response: SyncResponse | null) => void,
      ) => {
        if (stripCanonicalDigestMetadata) {
          metadata.remove('x-sync-canonical-digest')
        }
        const call = { request: grpcRequest, metadata } as unknown as grpc.ServerUnaryCall<SyncRequest, SyncResponse>

        void syncingServer.syncItems(call, (error, serverResponse) => {
          if (dropGrpcAfterServerAnswers) {
            callback(
              Object.assign(new Error('connection reset after the request bytes went out'), {
                code: Status.UNAVAILABLE,
                name: 'UNAVAILABLE',
                details: 'connection reset',
                metadata: new grpc.Metadata(),
              }) as grpc.ServiceError,
              null,
            )

            return
          }

          callback(error as grpc.ServiceError | null, serverResponse as SyncResponse | null)
        })

        return {} as never
      },
      getSyncCommandStatus: jest.fn(),
    }

    gatewayProxy = new GRPCSyncingServerServiceProxy(
      syncingClient as never,
      new SyncRequestGRPCMapper(),
      new GatewaySyncResponseGRPCMapper(),
      logger,
      {} as never,
      undefined,
      SHARED_INTERNAL_GRPC_SECRET,
    )
  })

  afterEach(async () => {
    await dispatcher.waitForIdle()
    await dataSource.destroy()
  })

  /**
   * THE CENTREPIECE. The exact production scenario the fallback branch exists
   * for: the item write reached the syncing server and COMMITTED, then the gRPC
   * connection died, so the gateway only learns `UNAVAILABLE` — which does not
   * prove the write was not applied. The gateway authorises the HTTP retry, and
   * the HTTP route must find the same ledger row and replay it.
   *
   * `syncItems.execute` called exactly ONCE across both transports is the
   * no-double-apply proof. Anything that breaks the ledger key, the digest
   * agreement or the header resolution turns that 1 into a 2.
   */
  it('replays the gRPC-committed ledger row over HTTP instead of applying the write twice', async () => {
    const payload = mutatingBody()
    const digest = gatewayComputeSyncCommandDigest(logicalSyncCommandPayload(payload))
    const request = expressRequest({ 'x-sync-command-id': 'command-cross-transport', 'x-sync-command-digest': digest })

    expect(gatewayProxy.durableCommandReplayKeyPresent(request, payload)).toBe(true)

    dropGrpcAfterServerAnswers = true
    await expect(gatewayProxy.sync(request, expressResponse(), payload)).rejects.toMatchObject({
      code: Status.UNAVAILABLE,
    })
    dropGrpcAfterServerAnswers = false

    const afterGrpc = await commandRows()
    expect(afterGrpc).toHaveLength(1)
    expect(afterGrpc[0]).toMatchObject({
      userUuid: USER_UUID,
      sessionUuid: SESSION_UUID,
      commandId: 'command-cross-transport',
      requestDigest: digest.toLowerCase(),
      status: 'committed',
    })
    expect(syncItems.execute).toHaveBeenCalledTimes(1)

    const httpResult = (await httpController.sync(
      forwardedOverHttp(request, payload),
      expressResponse(),
    )) as results.JsonResult

    expect(httpResult.statusCode).toBe(200)
    expect(syncItems.execute).toHaveBeenCalledTimes(1)
    const afterHttp = await commandRows()
    expect(afterHttp).toHaveLength(1)
    expect(afterHttp[0].uuid).toBe(afterGrpc[0].uuid)
    expect(httpResult.json).toEqual(JSON.parse(afterGrpc[0].responseJson as string))
    expect(httpResult.json).toMatchObject({
      command: { id: 'command-cross-transport', digest: digest.toLowerCase(), status: 'committed' },
    })
    expect(setHeader).toHaveBeenCalledWith('X-Sync-Command-Status', 'committed')
    expect(setHeader).toHaveBeenCalledWith('X-Sync-Command-Replayed', 'true')
  })

  /**
   * The same contract in the other direction, and the strongest single check on
   * digest canonicalisation in this file.
   *
   * The HTTP route stores a digest IT computed, from the body, with
   * `syncing-server`'s `canonicalJson`. The gRPC route then presents the digest
   * the GATEWAY computed, with api-gateway's own separate copy of that
   * algorithm, and `ExecuteSyncCommand.assertStoredDigestMatches` compares the
   * two. If the two canonicalisers ever disagree for this body, this test fails
   * with `sync_command_digest_mismatch` — which is exactly the dangerous case
   * stated as a success elsewhere: the gateway believing a write is deduplicated
   * when the server would not recognise it.
   *
   * The digest is also presented in a DIFFERENT CASE on the second hop, because
   * the ledger stores it lower-cased and the comparison must be case-folding.
   */
  it('accepts the gateway-computed digest against a row the HTTP route wrote itself', async () => {
    const payload = mutatingBody()
    const serverDigest = serverComputeSyncCommandDigest(logicalSyncCommandPayload(payload))
    const request = expressRequest({
      'x-sync-command-id': 'command-http-first',
      'x-sync-command-digest': serverDigest,
    })

    const httpResult = (await httpController.sync(
      forwardedOverHttp(request, payload),
      expressResponse(),
    )) as results.JsonResult
    expect(httpResult.statusCode).toBe(200)
    expect(syncItems.execute).toHaveBeenCalledTimes(1)

    const gatewayDigest = gatewayComputeSyncCommandDigest(logicalSyncCommandPayload(payload))
    const grpcRequest = expressRequest({
      'x-sync-command-id': 'command-http-first',
      'x-sync-command-digest': gatewayDigest.toUpperCase(),
    })
    expect(gatewayProxy.durableCommandReplayKeyPresent(grpcRequest, payload)).toBe(true)

    const grpcResult = await gatewayProxy.sync(grpcRequest, expressResponse(), payload)

    expect(grpcResult.status).toBe(200)
    expect(grpcResult.replayed).toBe(true)
    expect(syncItems.execute).toHaveBeenCalledTimes(1)
    const rows = await commandRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].requestDigest).toBe(serverDigest.toLowerCase())
    expect(grpcResult.data).toMatchObject({
      command: { id: 'command-http-first', digest: serverDigest.toLowerCase(), status: 'committed' },
    })
  })

  /**
   * The two packages each carry their own copy of the canonical-JSON algorithm
   * (`api-gateway/Service/Sync/SyncCommandDigest.canonicalSyncCommandJson` and
   * `syncing-server/Domain/SyncCommand/SyncCommandTypes.canonicalJson`). The
   * tests above would catch a divergence that affects the bodies they use; this
   * one sweeps the shapes a real sync body can take, and compares the canonical
   * STRINGS as well as the digests so a failure names the divergence rather than
   * just reporting two different hashes.
   */
  describe('digest canonicalisation', () => {
    const corpus: JsonObject[] = [
      {},
      { api: '20200115' },
      { api: '20200115', items: [] },
      { api: '20200115', sync_token: 'token', limit: 150, compute_integrity: false },
      /* The same logical body with every key order reversed: canonicalisation must sort. */
      { compute_integrity: false, limit: 150, sync_token: 'token', api: '20200115' },
      { api: '20200115', items: [{ uuid: 'b', content: null }, { uuid: 'a' }] },
      /* Array order, unlike key order, is MEANINGFUL and must survive. */
      { api: '20200115', items: [{ uuid: 'a' }, { uuid: 'b', content: null }] },
      { api: '20200115', shared_vault_uuids: [] },
      { api: '20200115', nested: { b: { d: [1, 2, 3], c: true }, a: 'x' } },
      { api: '20200115', absent: undefined, present: null },
      { api: '20200115', unicode: 'note — “quoted” é́ 🔒', escaped: 'a"b\\c\nd' },
      { api: '20200115', zero: 0, negativeZero: -0, float: 1.5, big: 1e21, empty: '', bool: false },
      { api: '20200115', emptyObject: {}, emptyArray: [], arrayOfEmpty: [{}, []] },
    ]

    it('agrees between api-gateway and syncing-server on every body shape', () => {
      /*
       * A corpus that can silently become empty is a gate that reads green
       * forever, so its exact size is asserted rather than its truthiness.
       */
      expect(corpus).toHaveLength(13)

      const divergences: string[] = []
      for (const body of corpus) {
        const gatewayJson = canonicalSyncCommandJson(body)
        const serverJson = canonicalJson(body)
        if (gatewayJson !== serverJson) {
          divergences.push(`gateway ${gatewayJson} !== server ${serverJson}`)
        }

        const gatewayDigest = gatewayComputeSyncCommandDigest(body)
        expect(gatewayDigest).toMatch(/^[a-f0-9]{64}$/)
        expect(serverComputeSyncCommandDigest(body)).toBe(gatewayDigest)
      }

      expect(divergences).toEqual([])
    })

    /**
     * A control for the comparison above: it must be capable of reporting a
     * divergence at all. Two bodies that differ only in a value the
     * canonicalisation keeps must hash differently on BOTH sides — otherwise an
     * all-constant canonicaliser would satisfy the parity test.
     */
    it('distinguishes bodies that differ, on both sides', () => {
      const left = { api: '20200115', items: [{ uuid: 'a' }, { uuid: 'b' }] }
      const right = { api: '20200115', items: [{ uuid: 'b' }, { uuid: 'a' }] }

      expect(canonicalSyncCommandJson(left)).not.toBe(canonicalSyncCommandJson(right))
      expect(canonicalJson(left)).not.toBe(canonicalJson(right))
      expect(gatewayComputeSyncCommandDigest(left)).not.toBe(gatewayComputeSyncCommandDigest(right))
      expect(serverComputeSyncCommandDigest(left)).not.toBe(serverComputeSyncCommandDigest(right))
    })

    /**
     * Both sides must hash the body WITHOUT the `command` envelope, or a
     * body-sourced command could never match a header-sourced one. Proven
     * end-to-end rather than by calling the (private) strippers: the gateway
     * authorises a body-sourced command whose digest was computed over the
     * header-sourced body, and the HTTP route commits it.
     */
    it('excludes the command envelope from the digest on both sides', async () => {
      const logicalBody = mutatingBody()
      const digest = gatewayComputeSyncCommandDigest(logicalBody)
      const bodyWithCommand = { ...logicalBody, command: { id: 'command-envelope', digest } }

      expect(gatewayProxy.durableCommandReplayKeyPresent(expressRequest(), bodyWithCommand)).toBe(true)

      const httpResult = (await httpController.sync(
        forwardedOverHttp(expressRequest(), bodyWithCommand),
        expressResponse(),
      )) as results.JsonResult

      expect(httpResult.statusCode).toBe(200)
      const rows = await commandRows()
      expect(rows).toHaveLength(1)
      expect(rows[0].requestDigest).toBe(digest.toLowerCase())
    })
  })

  /**
   * `resolveSyncCommandMetadata` reads headers AND body on both sides, so the
   * three presentation forms must be interchangeable. Each form is committed
   * under its own command id first (proving all three reach the ledger with the
   * same digest), then one id committed via headers is RE-PRESENTED as a body
   * command and must replay rather than apply a second time.
   */
  describe('header-sourced and body-sourced metadata', () => {
    const presentations = (digest: string, commandId: string) => [
      {
        form: 'headers only',
        headers: { 'x-sync-command-id': commandId, 'x-sync-command-digest': digest },
        envelope: {} as JsonObject,
      },
      {
        form: 'body only',
        headers: {} as Record<string, string | string[]>,
        envelope: { command: { id: commandId, digest } } as JsonObject,
      },
      {
        form: 'headers and body agreeing',
        headers: { 'x-sync-command-id': commandId, 'x-sync-command-digest': digest },
        envelope: { command: { id: commandId, digest } } as JsonObject,
      },
    ]

    it('commits every presentation form onto the same digest', async () => {
      const logicalBody = mutatingBody()
      const digest = gatewayComputeSyncCommandDigest(logicalBody)
      const forms = presentations(digest, 'placeholder')
      expect(forms).toHaveLength(3)

      for (const [index, shape] of forms.entries()) {
        const commandId = `command-form-${index}`
        const { headers, envelope } = presentations(digest, commandId)[index]
        const payload = { ...logicalBody, ...envelope }
        const request = expressRequest(headers, payload)

        expect(gatewayProxy.durableCommandReplayKeyPresent(request, payload)).toBe(true)

        const result = (await httpController.sync(
          forwardedOverHttp(request, payload),
          expressResponse(),
        )) as results.JsonResult

        expect(result.statusCode).toBe(200)
        expect(result.json).toMatchObject({
          command: { id: commandId, digest: digest.toLowerCase(), status: 'committed' },
        })
        expect(shape.form).toBeTruthy()
      }

      const rows = await commandRows()
      expect(rows).toHaveLength(3)
      expect(rows.map((row) => row.commandId)).toEqual(['command-form-0', 'command-form-1', 'command-form-2'])
      expect(new Set(rows.map((row) => row.requestDigest))).toEqual(new Set([digest.toLowerCase()]))
      expect(syncItems.execute).toHaveBeenCalledTimes(3)
    })

    it('replays a header-presented command when it comes back as a body command', async () => {
      const logicalBody = mutatingBody()
      const digest = gatewayComputeSyncCommandDigest(logicalBody)

      const headerRequest = expressRequest({
        'x-sync-command-id': 'command-switching-form',
        'x-sync-command-digest': digest,
      })
      await httpController.sync(forwardedOverHttp(headerRequest, logicalBody), expressResponse())
      expect(syncItems.execute).toHaveBeenCalledTimes(1)

      const bodyPayload = { ...logicalBody, command: { id: 'command-switching-form', digest } }
      const bodyRequest = expressRequest({}, bodyPayload)
      expect(gatewayProxy.durableCommandReplayKeyPresent(bodyRequest, bodyPayload)).toBe(true)

      const replay = (await httpController.sync(
        forwardedOverHttp(bodyRequest, bodyPayload),
        expressResponse(),
      )) as results.JsonResult

      expect(replay.statusCode).toBe(200)
      expect(syncItems.execute).toHaveBeenCalledTimes(1)
      expect(await commandRows()).toHaveLength(1)
      expect(setHeader).toHaveBeenCalledWith('X-Sync-Command-Replayed', 'true')
    })
  })

  /**
   * The failure direction, which is the half that actually protects users: every
   * presentation the gateway REFUSES must be refused, and every presentation it
   * AUTHORISES must reach the ledger on the HTTP hop. The second clause is the
   * dangerous one — an authorised presentation the HTTP route does not recognise
   * as a command would run the un-ledgered path and apply the write twice.
   */
  describe('refusal and authorisation agree', () => {
    const validDigest = () => gatewayComputeSyncCommandDigest(logicalSyncCommandPayload(mutatingBody()))

    const cases = () => {
      const digest = validDigest()

      return [
        {
          name: 'no command key at all',
          headers: {} as Record<string, string | string[]>,
          envelope: {} as JsonObject,
          authorised: false,
        },
        {
          name: 'id header without a digest header',
          headers: { 'x-sync-command-id': 'command-1' },
          envelope: {},
          authorised: false,
        },
        {
          name: 'digest header without an id header',
          headers: { 'x-sync-command-digest': digest },
          envelope: {},
          authorised: false,
        },
        {
          name: 'empty id header',
          headers: { 'x-sync-command-id': '', 'x-sync-command-digest': digest },
          envelope: {},
          authorised: false,
        },
        {
          name: 'id with characters outside the opaque-text grammar',
          headers: { 'x-sync-command-id': 'command 1/../etc', 'x-sync-command-digest': digest },
          envelope: {},
          authorised: false,
        },
        {
          name: 'id longer than 128 bytes',
          headers: { 'x-sync-command-id': 'a'.repeat(129), 'x-sync-command-digest': digest },
          envelope: {},
          authorised: false,
        },
        {
          name: 'digest that is not a SHA-256 hex string',
          headers: { 'x-sync-command-id': 'command-1', 'x-sync-command-digest': 'not-a-digest' },
          envelope: {},
          authorised: false,
        },
        {
          name: 'well-formed digest of a DIFFERENT body',
          headers: { 'x-sync-command-id': 'command-1', 'x-sync-command-digest': 'f'.repeat(64) },
          envelope: {},
          authorised: false,
        },
        {
          name: 'duplicate command headers',
          headers: { 'x-sync-command-id': ['command-1', 'command-2'], 'x-sync-command-digest': digest },
          envelope: {},
          authorised: false,
        },
        {
          name: 'headers and body disagreeing on the id',
          headers: { 'x-sync-command-id': 'header-id', 'x-sync-command-digest': digest },
          envelope: { command: { id: 'body-id', digest } },
          authorised: false,
        },
        {
          name: 'a command envelope that is not an object',
          headers: {},
          envelope: { command: 'command-1' },
          authorised: false,
        },
        {
          name: 'a well-formed header-sourced key',
          headers: { 'x-sync-command-id': 'command-ok-headers', 'x-sync-command-digest': digest },
          envelope: {},
          authorised: true,
        },
        {
          name: 'a well-formed body-sourced key',
          headers: {},
          envelope: { command: { id: 'command-ok-body', digest } },
          authorised: true,
        },
      ]
    }

    it('covers both verdicts with a corpus that cannot silently empty', () => {
      const table = cases()
      expect(table).toHaveLength(13)
      expect(table.filter((entry) => entry.authorised)).toHaveLength(2)
      expect(table.filter((entry) => !entry.authorised)).toHaveLength(11)
    })

    it.each(cases().map((entry) => [entry.name, entry] as const))(
      'the gateway verdict for %s is matched by the HTTP route',
      async (_name, entry) => {
        const payload = { ...mutatingBody(), ...entry.envelope }
        const request = expressRequest(entry.headers, payload)

        expect(gatewayProxy.durableCommandReplayKeyPresent(request, payload)).toBe(entry.authorised)

        if (!entry.authorised) {
          /*
           * A refused presentation is NOT a read, so `syncReplaySafety` falls
           * through to `non-idempotent-mutation`, for which the eligibility
           * table is empty — no failure class permits the HTTP hop at all. The
           * two facts together are the refusal; `GRPCServiceProxy.spec.ts` pins
           * the branch that consumes them.
           */
          expect(syncPayloadWritesNothing(payload)).toBe(false)

          return
        }

        const result = (await httpController.sync(
          forwardedOverHttp(request, payload),
          expressResponse(),
        )) as results.JsonResult

        expect(result.statusCode).toBe(200)
        const rows = await commandRows()
        expect(rows).toHaveLength(1)
        expect(rows[0].requestDigest).toBe(validDigest().toLowerCase())
        expect(rows[0].status).toBe('committed')
        expect(syncItems.execute).toHaveBeenCalledTimes(1)
      },
    )

    it('leaves no failure class on which an un-deduplicated write may cross transports', () => {
      const safeties = Object.keys(GRPC_FALLBACK_ELIGIBILITY) as GrpcCallReplaySafety[]
      expect(safeties).toEqual(['read-only', 'idempotent-mutation', 'non-idempotent-mutation'])
      expect(GRPC_FALLBACK_ELIGIBILITY['non-idempotent-mutation']).toEqual([])
      expect(GRPC_FALLBACK_ELIGIBILITY['idempotent-mutation'].length).toBeGreaterThan(0)
      expect(GRPC_FALLBACK_ELIGIBILITY['read-only'].length).toBeGreaterThan(0)
    })

    /**
     * A refused presentation must not be replayable by accident either: the
     * gRPC route itself rejects the same shapes, so a client cannot commit a row
     * over one transport that the other would refuse to recognise.
     */
    it('rejects a digest that disagrees with the body on the gRPC route too, writing no row', async () => {
      const payload = mutatingBody()
      const request = expressRequest({
        'x-sync-command-id': 'command-mismatched',
        'x-sync-command-digest': 'f'.repeat(64),
      })

      const grpcResult = await gatewayProxy.sync(request, expressResponse(), payload)
      expect(grpcResult.status).toBe(409)

      const httpResult = (await httpController.sync(
        forwardedOverHttp(request, payload),
        expressResponse(),
      )) as results.JsonResult
      expect(httpResult.statusCode).toBe(409)
      expect((httpResult.json as { error: { code: string } }).error.code).toBe('sync_command_digest_mismatch')

      expect(syncItems.execute).not.toHaveBeenCalled()
      expect(await commandRows()).toHaveLength(0)
    })
  })

  /**
   * A documented NON-equivalence, pinned so it cannot be mistaken for parity,
   * together with the thing that keeps it out of reach.
   *
   * The HTTP route ALWAYS recomputes the digest from the forwarded body. The
   * gRPC route does so only when `x-sync-canonical-digest` is absent, and in
   * that branch it hashes `SyncingServer.createCanonicalPayload(request)` — a
   * payload rebuilt from the protobuf, which cannot round-trip a sync body (it
   * always emits `items`, and drops an empty `shared_vault_uuids`). That branch
   * is therefore NOT digest-equivalent to the HTTP route.
   *
   * It is unreachable for the gateway because the signed scope BINDS the body
   * digest: stripping or altering the metadata invalidates the signature and the
   * call fails closed, before the ledger. Both halves are asserted, because the
   * safety of the fallback rests on the binding, not on the gateway choosing to
   * send the header.
   */
  describe('the protobuf-reconstructed canonical payload', () => {
    const bodyWithoutItems: JsonObject = { api: '20200115', sync_token: 'token-without-items' }

    /** A caller that signs WITHOUT a body digest — the only way into the reconstruction branch. */
    const callGrpcWithoutCanonicalDigest = async (payload: JsonObject, commandId: string, digest: string) => {
      const auth = new InternalGrpcServiceAuth(SHARED_INTERNAL_GRPC_SECRET)
      const proof = auth.sign({
        method: 'syncItems',
        userUuid: USER_UUID,
        sessionUuid: SESSION_UUID,
        commandId,
        commandDigest: digest,
      })
      const metadata = new grpc.Metadata()
      metadata.set('x-user-uuid', USER_UUID)
      metadata.set('x-session-uuid', SESSION_UUID)
      metadata.set('x-snjs-version', '2.200.0')
      metadata.set(INTERNAL_GRPC_AUTH_METADATA.version, proof.version)
      metadata.set(INTERNAL_GRPC_AUTH_METADATA.timestamp, proof.timestamp)
      metadata.set(INTERNAL_GRPC_AUTH_METADATA.signature, proof.signature)

      const grpcRequest = new SyncRequestGRPCMapper().toProjection({
        ...payload,
        command: { id: commandId, digest },
      })
      const call = { request: grpcRequest, metadata } as unknown as grpc.ServerUnaryCall<SyncRequest, SyncResponse>

      return new Promise<{ code?: number; errorCode?: string }>((resolve) => {
        void syncingServer.syncItems(call, (error) => {
          resolve({
            code: error?.metadata ? Number(error.metadata.get('x-sync-error-response-code').pop()) : undefined,
            errorCode: error?.metadata?.get('x-sync-error-code').pop() as string | undefined,
          })
        })
      })
    }

    it('is NOT digest-equivalent to the HTTP body, so that branch cannot carry a replay', async () => {
      const digest = gatewayComputeSyncCommandDigest(logicalSyncCommandPayload(bodyWithoutItems))

      /* Control: the SAME branch, with a body the protobuf can round-trip, commits. */
      const roundTrippable = { ...bodyWithoutItems, items: [] }
      const roundTrippableDigest = gatewayComputeSyncCommandDigest(logicalSyncCommandPayload(roundTrippable))
      await expect(
        callGrpcWithoutCanonicalDigest(roundTrippable, 'command-reconstructable', roundTrippableDigest),
      ).resolves.toEqual({ code: undefined, errorCode: undefined })
      expect(await commandRows()).toHaveLength(1)

      /* The divergence: a body with no `items` key, which the reconstruction invents. */
      await expect(
        callGrpcWithoutCanonicalDigest(bodyWithoutItems, 'command-reconstruction-gap', digest),
      ).resolves.toEqual({ code: 409, errorCode: 'sync_command_digest_mismatch' })
      expect(await commandRows()).toHaveLength(1)
    })

    it('is kept unreachable by the signature binding the canonical body digest', async () => {
      const digest = gatewayComputeSyncCommandDigest(logicalSyncCommandPayload(bodyWithoutItems))
      const request = expressRequest({ 'x-sync-command-id': 'command-no-items', 'x-sync-command-digest': digest })

      const withMetadata = await gatewayProxy.sync(request, expressResponse(), bodyWithoutItems)
      expect(withMetadata.status).toBe(200)
      expect(await commandRows()).toHaveLength(1)

      stripCanonicalDigestMetadata = true
      const strippedRequest = expressRequest({
        'x-sync-command-id': 'command-no-items-stripped',
        'x-sync-command-digest': digest,
      })
      const withoutMetadata = await gatewayProxy.sync(strippedRequest, expressResponse(), bodyWithoutItems)

      expect(withoutMetadata.status).toBe(401)
      expect(withoutMetadata.data).toMatchObject({
        error: { code: 'sync_command_authentication_failed', retryable: false },
      })
      expect(await commandRows()).toHaveLength(1)
    })
  })
})
