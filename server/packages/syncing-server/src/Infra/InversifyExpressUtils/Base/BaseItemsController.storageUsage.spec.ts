import { Result } from '@standardnotes/domain-core'
import { Request, Response } from 'express'
import { results } from 'inversify-express-utils'
import { Logger } from 'winston'

import { BaseItemsController } from './BaseItemsController'

/**
 * Standard Red Notes: the storage-usage endpoint, including the one line without
 * which it is dead on every single-container deployment while every build and
 * every route table stays green.
 */
describe('BaseItemsController storage usage', () => {
  let getUserStorageUsage: { execute: jest.Mock }
  let logger: jest.Mocked<Logger>
  let registrations: Record<string, unknown>
  let controllerContainer: { register: jest.Mock }

  const createController = (overrides: { withUseCase?: boolean; withContainer?: boolean } = {}) =>
    new BaseItemsController(
      { execute: jest.fn().mockResolvedValue(Result.ok()) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      logger,
      false,
      5,
      100,
      50,
      10_000,
      5_000,
      5,
      overrides.withContainer === false ? undefined : (controllerContainer as never),
      undefined,
      undefined,
      undefined,
      overrides.withUseCase === false ? undefined : (getUserStorageUsage as never),
    )

  const response = (): Response => ({ locals: { user: { uuid: 'user-1' } } }) as unknown as Response

  const request = (): Request => ({ body: {}, headers: {}, params: {} }) as unknown as Request

  const bodyOf = (result: results.JsonResult): Record<string, unknown> => result.json as Record<string, unknown>

  const statusOf = (result: results.JsonResult): number => result.statusCode as number

  beforeEach(() => {
    registrations = {}
    controllerContainer = {
      register: jest.fn((name: string, handler: unknown) => {
        registrations[name] = handler
      }),
    }
    getUserStorageUsage = {
      execute: jest.fn().mockResolvedValue(Result.ok({ sizedBytes: 4_096, sizedItems: 3, unsizedItems: 0 })),
    }
    logger = { debug: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn() } as unknown as jest.Mocked<Logger>
  })

  it('answers the measured bytes and both item counts', async () => {
    const result = await createController().getStorageUsage(request(), response())

    expect(bodyOf(result as never)).toEqual({ itemBytesUsed: 4_096, itemsMeasured: 3, itemsUnmeasured: 0 })
  })

  /**
   * The ONE scope rule: the figure is the requesting session's own, taken from
   * `response.locals` and from nothing a caller can influence. There is no route
   * parameter and no body read, so there is nothing to assert about either — what
   * there is to assert is that the uuid reaching the use case is the local one.
   */
  it('scopes the read to the authenticated session and nothing else', async () => {
    await createController().getStorageUsage(request(), response())

    expect(getUserStorageUsage.execute).toHaveBeenCalledWith({ userUuid: 'user-1' })
  })

  /**
   * *** A MEASURED ZERO IS A FIGURE AND MUST SURVIVE THE CONTROLLER. *** An empty
   * account answers 200 with zeros rather than an error or an empty body: the pane
   * renders "0 MB measured" and "we could not measure it" completely differently,
   * and only the server can tell it which one this is.
   */
  it('answers a measured zero as a 200 with zeros, not as an absence', async () => {
    getUserStorageUsage.execute = jest
      .fn()
      .mockResolvedValue(Result.ok({ sizedBytes: 0, sizedItems: 0, unsizedItems: 0 }))

    const result = await createController().getStorageUsage(request(), response())

    expect(bodyOf(result as never)).toEqual({ itemBytesUsed: 0, itemsMeasured: 0, itemsUnmeasured: 0 })
  })

  it('carries the unmeasured count out, so the client can say the total is a floor', async () => {
    getUserStorageUsage.execute = jest
      .fn()
      .mockResolvedValue(Result.ok({ sizedBytes: 1_024, sizedItems: 1, unsizedItems: 7 }))

    expect(bodyOf((await createController().getStorageUsage(request(), response())) as never)).toEqual({
      itemBytesUsed: 1_024,
      itemsMeasured: 1,
      itemsUnmeasured: 7,
    })
  })

  /**
   * *** 503 RATHER THAN A ZERO. *** An unwired dependency must never be
   * indistinguishable from an account holding nothing, which is exactly what a
   * `{ itemBytesUsed: 0 }` fallback would be.
   */
  it('answers 503 rather than a zero when the use case is not wired', async () => {
    const result = await createController({ withUseCase: false }).getStorageUsage(request(), response())

    expect(statusOf(result as never)).toEqual(503)
    expect(JSON.stringify(bodyOf(result as never))).not.toContain('itemBytesUsed')
  })

  it('answers 500 rather than a zero when the read throws', async () => {
    getUserStorageUsage.execute = jest.fn().mockRejectedValue(new Error('database gone'))

    const result = await createController().getStorageUsage(request(), response())

    expect(statusOf(result as never)).toEqual(500)
    expect(JSON.stringify(bodyOf(result as never))).not.toContain('itemBytesUsed')
  })

  it('answers 400 rather than a zero when the use case refuses the input', async () => {
    getUserStorageUsage.execute = jest.fn().mockResolvedValue(Result.fail('not a uuid'))

    const result = await createController().getStorageUsage(request(), response())

    expect(statusOf(result as never)).toEqual(400)
    expect(JSON.stringify(bodyOf(result as never))).not.toContain('itemBytesUsed')
  })

  /**
   * *** THE DIRECT-CALL REGISTRATION, ASSERTED BY NAME. ***
   *
   * On a single container the gateway does not make an HTTP request: it resolves a
   * method identifier and looks it up in this registry. A new endpoint without
   * this line builds, routes, typechecks and answers "Method not found" at
   * runtime — this repo has shipped exactly that gap before, across nine endpoints
   * at once. The identifier is asserted as a STRING because the string is the
   * contract: the gateway's own table holds the same literal, and a rename on one
   * side only is the failure this test exists to catch.
   */
  it('registers the direct-call handler the single-container gateway resolves', async () => {
    createController()

    expect(Object.keys(registrations)).toContain('sync.items.storage_usage')
  })

  it('registers a handler that actually answers the figure, not merely a name', async () => {
    createController()

    const handler = registrations['sync.items.storage_usage'] as (
      request: Request,
      response: Response,
    ) => Promise<unknown>
    const result = await handler(request(), response())

    expect(bodyOf(result as never)).toEqual({ itemBytesUsed: 4_096, itemsMeasured: 3, itemsUnmeasured: 0 })
  })

  it('still answers over HTTP with no controller container at all', async () => {
    const result = await createController({ withContainer: false }).getStorageUsage(request(), response())

    expect(bodyOf(result as never)).toEqual({ itemBytesUsed: 4_096, itemsMeasured: 3, itemsUnmeasured: 0 })
  })
})
