import { Result } from '@standardnotes/domain-core'
import { Request, Response } from 'express'
import { results } from 'inversify-express-utils'
import { Logger } from 'winston'

import { ADMIN_STORAGE_USAGE_MAX_USERS, BaseItemsController } from './BaseItemsController'

/**
 * Standard Red Notes: the admin per-account stored-item read — the endpoint that
 * exists because an administrator could get a space report for themselves and for
 * nobody else.
 *
 * *** THE DEFECT, PRECISELY. *** `getStorageUsage` takes its subject from
 * `response.locals` and is the only route that published the measurement, so an
 * administrator asking about three accounts holding 3 MB, 7 MB and 11 MB of notes
 * was answered their OWN figure three times. The property that makes that
 * impossible here is not "a number came back" — it is that the uuids reaching the
 * use case are the ones the REQUEST named, and that each answered entry carries
 * the account it measures. Both are asserted below, and neither can be satisfied
 * by a handler that reads the session.
 */
describe('BaseItemsController admin storage usage', () => {
  let getUsersStorageUsage: { execute: jest.Mock }
  let logger: jest.Mocked<Logger>
  let registrations: Record<string, unknown>
  let controllerContainer: { register: jest.Mock }

  const SESSION_USER = '00000000-0000-0000-0000-00000000000a'
  const OTHER_USER = '00000000-0000-0000-0000-00000000000b'
  const THIRD_USER = '00000000-0000-0000-0000-00000000000c'

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
      undefined,
      overrides.withUseCase === false ? undefined : (getUsersStorageUsage as never),
    )

  const responseFor = (roleNames: string[] | undefined): Response =>
    ({
      locals: {
        user: { uuid: SESSION_USER },
        ...(roleNames === undefined ? {} : { roles: roleNames.map((name, index) => ({ uuid: `r${index}`, name })) }),
      },
    }) as unknown as Response

  const adminResponse = (): Response => responseFor(['ADMIN_USER'])

  const requestFor = (body: unknown): Request => ({ body, headers: {}, params: {}, query: {} }) as unknown as Request

  const bodyOf = (result: results.JsonResult): Record<string, unknown> => result.json as Record<string, unknown>

  const statusOf = (result: results.JsonResult): number => result.statusCode as number

  beforeEach(() => {
    registrations = {}
    controllerContainer = {
      register: jest.fn((name: string, handler: unknown) => {
        registrations[name] = handler
      }),
    }
    getUsersStorageUsage = {
      execute: jest.fn((dto: { userUuids: string[] }) =>
        Promise.resolve(
          Result.ok(
            dto.userUuids.map((userUuid, index) => ({
              userUuid,
              sizedBytes: (index + 1) * 1_000,
              sizedItems: index + 1,
              unsizedItems: 0,
            })),
          ),
        ),
      ),
    }
    logger = { debug: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn() } as unknown as jest.Mocked<Logger>
  })

  /**
   * *** THE REGRESSION PIN. *** Three accounts, three answers, and the subjects
   * are the request's. A handler that read `locals.user.uuid` — which is what the
   * only pre-existing route does — fails both halves of this at once.
   */
  it('measures the accounts the REQUEST names, not the session that asked', async () => {
    const result = await createController().getStorageUsageForUsers(
      requestFor({ userUuids: [OTHER_USER, THIRD_USER] }),
      adminResponse(),
    )

    expect(getUsersStorageUsage.execute).toHaveBeenCalledWith({ userUuids: [OTHER_USER, THIRD_USER] })
    expect(bodyOf(result as never)).toEqual({
      usages: [
        { userUuid: OTHER_USER, itemBytesUsed: 1_000, itemsMeasured: 1, itemsUnmeasured: 0 },
        { userUuid: THIRD_USER, itemBytesUsed: 2_000, itemsMeasured: 2, itemsUnmeasured: 0 },
      ],
    })
  })

  it('answers an entry per requested account, each naming the account it measures', async () => {
    const result = await createController().getStorageUsageForUsers(
      requestFor({ userUuids: [SESSION_USER, OTHER_USER, THIRD_USER] }),
      adminResponse(),
    )

    const usages = bodyOf(result as never).usages as Array<{ userUuid: string; itemBytesUsed: number }>
    expect(usages.map((usage) => usage.userUuid)).toEqual([SESSION_USER, OTHER_USER, THIRD_USER])
    // Three different figures, because a report that cannot distinguish three
    // accounts is the report this endpoint replaced.
    expect(new Set(usages.map((usage) => usage.itemBytesUsed)).size).toBe(3)
  })

  it('carries the unmeasured-item count through, so a bound cannot read as a total', async () => {
    getUsersStorageUsage.execute.mockResolvedValue(
      Result.ok([{ userUuid: OTHER_USER, sizedBytes: 4_096, sizedItems: 2, unsizedItems: 7 }]),
    )

    const result = await createController().getStorageUsageForUsers(
      requestFor({ userUuids: [OTHER_USER] }),
      adminResponse(),
    )

    expect(bodyOf(result as never)).toEqual({
      usages: [{ userUuid: OTHER_USER, itemBytesUsed: 4_096, itemsMeasured: 2, itemsUnmeasured: 7 }],
    })
  })

  /**
   * *** THE GATE LIVES IN THE HANDLER, AND THIS IS THE TEST THAT KEEPS IT THERE. ***
   * On the single-container topology the api-gateway invokes this handler through
   * the controller container, which runs no Express middleware. A guard moved into
   * a middleware would pass every test that goes through the route and be absent
   * on the deployment this project ships by default.
   */
  it('refuses a requestor without the admin role', async () => {
    const result = await createController().getStorageUsageForUsers(
      requestFor({ userUuids: [OTHER_USER] }),
      responseFor(['CORE_USER']),
    )

    expect(statusOf(result as never)).toBe(403)
    expect(getUsersStorageUsage.execute).not.toHaveBeenCalled()
  })

  it('fails CLOSED when the token carried no roles at all', async () => {
    const result = await createController().getStorageUsageForUsers(
      requestFor({ userUuids: [OTHER_USER] }),
      responseFor(undefined),
    )

    expect(statusOf(result as never)).toBe(403)
    expect(getUsersStorageUsage.execute).not.toHaveBeenCalled()
  })

  /**
   * An unwired dependency must never look like a fleet of accounts holding
   * nothing — the same rule the self-scoped read follows, and for the same reason:
   * "we could not measure it" and "there is nothing stored" are different facts
   * and the pane consuming this is built entirely around keeping them apart.
   */
  it('answers 503 rather than a fabricated figure when the use case is absent', async () => {
    const result = await createController({ withUseCase: false }).getStorageUsageForUsers(
      requestFor({ userUuids: [OTHER_USER] }),
      adminResponse(),
    )

    expect(statusOf(result as never)).toBe(503)
    expect(bodyOf(result as never).usages).toBeUndefined()
  })

  it('refuses a body that does not name a list of accounts', async () => {
    for (const body of [undefined, {}, { userUuids: 'not-an-array' }, { userUuids: [1, 2] }]) {
      const result = await createController().getStorageUsageForUsers(requestFor(body), adminResponse())

      expect(statusOf(result as never)).toBe(400)
    }
    expect(getUsersStorageUsage.execute).not.toHaveBeenCalled()
  })

  it('answers an empty page without inventing anything', async () => {
    const result = await createController().getStorageUsageForUsers(requestFor({ userUuids: [] }), adminResponse())

    expect(bodyOf(result as never)).toEqual({ usages: [] })
  })

  it('refuses more accounts than one page of the admin users list can hold', async () => {
    const tooMany = Array.from({ length: ADMIN_STORAGE_USAGE_MAX_USERS + 1 }, () => OTHER_USER)

    const result = await createController().getStorageUsageForUsers(requestFor({ userUuids: tooMany }), adminResponse())

    expect(statusOf(result as never)).toBe(400)
    expect(getUsersStorageUsage.execute).not.toHaveBeenCalled()
  })

  it('reports a use-case failure as a refusal, not as an empty measurement', async () => {
    getUsersStorageUsage.execute.mockResolvedValue(Result.fail('Given value is not a valid uuid: not-a-uuid'))

    const result = await createController().getStorageUsageForUsers(
      requestFor({ userUuids: ['not-a-uuid'] }),
      adminResponse(),
    )

    expect(statusOf(result as never)).toBe(400)
    expect(bodyOf(result as never).usages).toBeUndefined()
  })

  it('reports a thrown read as a failure rather than as accounts holding nothing', async () => {
    getUsersStorageUsage.execute.mockRejectedValue(new Error('connection lost'))

    const result = await createController().getStorageUsageForUsers(
      requestFor({ userUuids: [OTHER_USER] }),
      adminResponse(),
    )

    expect(statusOf(result as never)).toBe(500)
    expect(bodyOf(result as never).usages).toBeUndefined()
    expect(logger.error).toHaveBeenCalled()
  })

  /**
   * *** WITHOUT THIS REGISTRATION THE ENDPOINT IS DEAD ON EVERY SINGLE-CONTAINER
   * DEPLOYMENT *** while the build, the route table and the HTTP topology all stay
   * green: the gateway resolves a method identifier the container has never heard
   * of and answers "Method not found". This repo has shipped that exact gap.
   */
  it('registers itself for the single-container direct-call topology', () => {
    createController()

    expect(Object.keys(registrations)).toContain('sync.items.storage_usage_for_users')
    expect(typeof registrations['sync.items.storage_usage_for_users']).toBe('function')
    // The self-scoped read keeps its own registration; one must not replace the
    // other, because the two answer different questions.
    expect(Object.keys(registrations)).toContain('sync.items.storage_usage')
  })

  it('registers nothing when there is no controller container to register with', () => {
    createController({ withContainer: false })

    expect(controllerContainer.register).not.toHaveBeenCalled()
  })
})
