import 'reflect-metadata'

import { Request, Response } from 'express'
import { MapperInterface, Result, Timestamps, Uuid } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { BaseSubscriptionSettingsController } from './BaseSubscriptionSettingsController'
import { GetSharedOrRegularSubscriptionForUser } from '../../../Domain/UseCase/GetSharedOrRegularSubscriptionForUser/GetSharedOrRegularSubscriptionForUser'
import { GetSubscriptionSetting } from '../../../Domain/UseCase/GetSubscriptionSetting/GetSubscriptionSetting'
import { ResolveFileQuotaScope } from '../../../Domain/UseCase/ResolveFileQuotaScope/ResolveFileQuotaScope'
import { SetSubscriptionSettingValue } from '../../../Domain/UseCase/SetSubscriptionSettingValue/SetSubscriptionSettingValue'
import { SubscriptionSetting } from '../../../Domain/Setting/SubscriptionSetting'
import { SubscriptionSettingHttpMapper } from '../../../Mapping/Http/SubscriptionSettingHttpMapper'
import { SubscriptionSettingHttpRepresentation } from '../../../Mapping/Http/SubscriptionSettingHttpRepresentation'
import { SubscriptionSettingsAssociationServiceInterface } from '../../../Domain/Setting/SubscriptionSettingsAssociationServiceInterface'
import { TriggerPostSettingUpdateActions } from '../../../Domain/UseCase/TriggerPostSettingUpdateActions/TriggerPostSettingUpdateActions'
import { EncryptionVersion } from '../../../Domain/Encryption/EncryptionVersion'

/**
 * Standard Red Notes: the SELF-SCOPED subscription-setting read.
 *
 * *** THE DEFECT THESE TESTS PIN DOWN. ***
 *
 * An operator on a real deployment — signed in, PRO_PLAN active, files on disk —
 * reported every Space figure as "not reported". Both figures are keyed on a
 * `user_subscriptions` row, the default entitlement mode never creates one, and
 * `GetUserSubscription` synthesises a PRO_PLAN subscription for the client anyway.
 * So the account presented as subscribed and this endpoint answered
 * `200 {setting: undefined}` for both names, forever.
 *
 * Two properties are asserted here and they are deliberately ASYMMETRIC, because
 * the two figures are different kinds of fact:
 *
 *   1. The ALLOWANCE is derived when no row holds one, because an absent limit was
 *      never an absent allowance: `CreateValetToken` applies the plan default, and
 *      unlimited where there is no live subscription. The answer carries an
 *      `origin` so a reader can tell a decision from a default.
 *
 *   2. The USAGE total is NEVER derived. A fabricated zero and a measured zero are
 *      the same number and different answers, and only one of them is true — so an
 *      account whose upload bookkeeping was lost must keep reading as absent, or
 *      the client-side finding about it becomes permanently unreachable.
 */
describe('BaseSubscriptionSettingsController', () => {
  const USER_UUID = '11111111-1111-4111-8111-111111111111'
  const SUBSCRIPTION_UUID = '22222222-2222-4222-8222-222222222222'

  let doGetSetting: GetSubscriptionSetting
  let getSharedOrRegularSubscription: GetSharedOrRegularSubscriptionForUser
  let setSubscriptionSettingValue: SetSubscriptionSettingValue
  let triggerPostSettingUpdateActions: TriggerPostSettingUpdateActions
  let subscriptionSettingMapper: MapperInterface<SubscriptionSetting, SubscriptionSettingHttpRepresentation>
  let resolveFileQuotaScope: ResolveFileQuotaScope
  let subscriptionSettingsAssociationService: SubscriptionSettingsAssociationServiceInterface
  let logger: Logger

  const createController = (options?: { wireDerivation?: boolean }) =>
    new BaseSubscriptionSettingsController(
      doGetSetting,
      getSharedOrRegularSubscription,
      setSubscriptionSettingValue,
      triggerPostSettingUpdateActions,
      subscriptionSettingMapper,
      logger,
      undefined,
      options?.wireDerivation === false ? undefined : resolveFileQuotaScope,
      options?.wireDerivation === false ? undefined : subscriptionSettingsAssociationService,
    )

  const requestFor = (settingName: string) =>
    ({ params: { subscriptionSettingName: settingName.toLowerCase() }, body: {} }) as unknown as Request

  const responseFor = () => ({ locals: { user: { uuid: USER_UUID, email: 'x@y.tld' } } }) as unknown as Response

  /** The JSON body a `results.JsonResult` carries, without re-implementing its shape. */
  const bodyOf = (result: { json: unknown }): Record<string, unknown> =>
    (result as unknown as { json: Record<string, unknown> }).json

  const storedSetting = (name: string, value: string): SubscriptionSetting =>
    SubscriptionSetting.create({
      name,
      value,
      sensitive: false,
      serverEncryptionVersion: EncryptionVersion.Unencrypted,
      timestamps: Timestamps.create(123, 456).getValue(),
      userSubscriptionUuid: Uuid.create(SUBSCRIPTION_UUID).getValue(),
    }).getValue()

  beforeEach(() => {
    doGetSetting = {} as jest.Mocked<GetSubscriptionSetting>
    doGetSetting.execute = jest.fn().mockReturnValue(Result.fail('not found'))

    getSharedOrRegularSubscription = {} as jest.Mocked<GetSharedOrRegularSubscriptionForUser>
    getSharedOrRegularSubscription.execute = jest.fn().mockReturnValue(Result.fail('no subscription'))

    setSubscriptionSettingValue = {} as jest.Mocked<SetSubscriptionSettingValue>
    setSubscriptionSettingValue.execute = jest
      .fn()
      .mockReturnValue(Result.ok(storedSetting('MUTE_SIGN_IN_EMAILS', 'x')))

    triggerPostSettingUpdateActions = {} as jest.Mocked<TriggerPostSettingUpdateActions>
    triggerPostSettingUpdateActions.execute = jest.fn().mockReturnValue(Result.ok())

    subscriptionSettingMapper = new SubscriptionSettingHttpMapper()

    resolveFileQuotaScope = {} as jest.Mocked<ResolveFileQuotaScope>
    resolveFileQuotaScope.execute = jest
      .fn()
      .mockReturnValue(Result.ok({ userSubscriptionUuid: USER_UUID, backedBySubscriptionRow: false }))

    subscriptionSettingsAssociationService = {} as jest.Mocked<SubscriptionSettingsAssociationServiceInterface>
    subscriptionSettingsAssociationService.getFileUploadLimit = jest.fn().mockResolvedValue(107_374_182_400)
    subscriptionSettingsAssociationService.getDefaultSettingsAndValuesForSubscriptionName = jest.fn()

    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()
  })

  /* ------------------------------------------------------------------------ */
  /* The effective allowance                                                  */
  /* ------------------------------------------------------------------------ */

  it('answers unlimited for an account with no live subscription, which is what the token minter grants', async () => {
    const result = await createController().getSubscriptionSetting(requestFor('FILE_UPLOAD_BYTES_LIMIT'), responseFor())

    expect(bodyOf(result)).toEqual({
      success: true,
      setting: {
        uuid: '',
        name: 'FILE_UPLOAD_BYTES_LIMIT',
        value: '-1',
        createdAt: 0,
        updatedAt: 0,
        sensitive: false,
        origin: 'no-active-subscription',
      },
    })
  })

  it('answers the plan default while a subscription is live, and says it was a default', async () => {
    resolveFileQuotaScope.execute = jest.fn().mockReturnValue(
      Result.ok({
        userSubscriptionUuid: SUBSCRIPTION_UUID,
        backedBySubscriptionRow: true,
        activePlanName: 'PRO_PLAN',
      }),
    )

    const result = await createController().getSubscriptionSetting(requestFor('FILE_UPLOAD_BYTES_LIMIT'), responseFor())

    expect(bodyOf(result).setting).toEqual(expect.objectContaining({ value: '107374182400', origin: 'plan-default' }))
    expect(subscriptionSettingsAssociationService.getFileUploadLimit).toHaveBeenCalledWith('PRO_PLAN')
  })

  it('prefers a stored per-account row over any default, and labels it as set for the account', async () => {
    doGetSetting.execute = jest
      .fn()
      .mockReturnValue(Result.ok({ setting: storedSetting('FILE_UPLOAD_BYTES_LIMIT', '5242880') }))

    const result = await createController().getSubscriptionSetting(requestFor('FILE_UPLOAD_BYTES_LIMIT'), responseFor())

    expect(bodyOf(result).setting).toEqual(expect.objectContaining({ value: '5242880', origin: 'account-setting' }))
    expect(subscriptionSettingsAssociationService.getFileUploadLimit).not.toHaveBeenCalled()
  })

  /**
   * A plan whose role is not seeded makes `getFileUploadLimit` THROW. A diagnostics
   * read must not become a 500 over that, and must not answer a guess either.
   */
  it('reports no allowance rather than a guess when the plan default cannot be determined', async () => {
    resolveFileQuotaScope.execute = jest.fn().mockReturnValue(
      Result.ok({
        userSubscriptionUuid: SUBSCRIPTION_UUID,
        backedBySubscriptionRow: true,
        activePlanName: 'PRO_PLAN',
      }),
    )
    subscriptionSettingsAssociationService.getFileUploadLimit = jest
      .fn()
      .mockRejectedValue(new Error('Could not find role'))

    const result = await createController().getSubscriptionSetting(requestFor('FILE_UPLOAD_BYTES_LIMIT'), responseFor())

    expect(bodyOf(result)).toEqual({ error: { message: 'not found' } })
    expect(logger.error).toHaveBeenCalled()
  })

  /* ------------------------------------------------------------------------ */
  /* The usage total is never synthesised                                     */
  /* ------------------------------------------------------------------------ */

  /**
   * *** THE ASYMMETRY, ASSERTED. ***
   *
   * If this endpoint answered `0` for a missing usage total, every deployment
   * would report a tidy zero and the client's "this account has files and the
   * server reports no usage figure for them" finding would be unreachable for
   * ever. A zero is a figure; unknown is not.
   */
  it('leaves a missing usage total absent rather than answering a fabricated zero', async () => {
    const result = await createController().getSubscriptionSetting(requestFor('FILE_UPLOAD_BYTES_USED'), responseFor())

    expect(bodyOf(result)).toEqual({ success: true, setting: undefined })
    expect(JSON.stringify(bodyOf(result))).not.toContain('"value"')
  })

  it('answers a stored usage total of zero as a zero', async () => {
    doGetSetting.execute = jest
      .fn()
      .mockReturnValue(Result.ok({ setting: storedSetting('FILE_UPLOAD_BYTES_USED', '0') }))

    const result = await createController().getSubscriptionSetting(requestFor('FILE_UPLOAD_BYTES_USED'), responseFor())

    expect(bodyOf(result).setting).toEqual(expect.objectContaining({ value: '0', origin: 'account-setting' }))
  })

  /* ------------------------------------------------------------------------ */
  /* The scope, and the contract for callers that do not wire the derivation  */
  /* ------------------------------------------------------------------------ */

  it('reads the usage total from the scope the write path uses', async () => {
    await createController().getSubscriptionSetting(requestFor('FILE_UPLOAD_BYTES_USED'), responseFor())

    expect(doGetSetting.execute).toHaveBeenCalledWith({
      userSubscriptionUuid: USER_UUID,
      allowSensitiveRetrieval: false,
      settingName: 'FILE_UPLOAD_BYTES_USED',
    })
  })

  it('still answers 400 for a missing row on a scope a real subscription backs', async () => {
    resolveFileQuotaScope.execute = jest
      .fn()
      .mockReturnValue(Result.ok({ userSubscriptionUuid: SUBSCRIPTION_UUID, backedBySubscriptionRow: true }))

    const result = await createController().getSubscriptionSetting(requestFor('MUTE_SIGN_IN_EMAILS'), responseFor())

    expect(bodyOf(result)).toEqual({ error: { message: 'not found' } })
  })

  /**
   * Both new dependencies are OPTIONAL, so every older construction of this
   * controller keeps compiling. Unwired, the endpoint must behave EXACTLY as it
   * did: the pre-existing shared-or-regular lookup, and `{setting: undefined}` for
   * an account with no row. Asserted so "optional" cannot quietly become "derives
   * nothing anywhere".
   */
  it('falls back to the pre-existing lookup and the old answer when the derivation is not wired', async () => {
    const result = await createController({ wireDerivation: false }).getSubscriptionSetting(
      requestFor('FILE_UPLOAD_BYTES_LIMIT'),
      responseFor(),
    )

    expect(bodyOf(result)).toEqual({ success: true, setting: undefined })
    expect(getSharedOrRegularSubscription.execute).toHaveBeenCalledWith({ userUuid: USER_UUID })
    expect(doGetSetting.execute).not.toHaveBeenCalled()
  })

  /* ------------------------------------------------------------------------ */
  /* The write path shares the scope                                          */
  /* ------------------------------------------------------------------------ */

  /**
   * A value written to one scope and read from another is a setting that silently
   * does nothing. This used to 400 for every account with no subscription row,
   * which made the `account-setting` origin unreachable and left these settings
   * permanently unwritable rather than merely unset.
   */
  it('writes to the same scope the read resolves', async () => {
    const request = {
      params: {},
      body: { name: 'MUTE_SIGN_IN_EMAILS', value: 'muted' },
    } as unknown as Request

    const result = await createController().updateSubscriptionSetting(request, responseFor())

    expect(setSubscriptionSettingValue.execute).toHaveBeenCalledWith({
      settingName: 'MUTE_SIGN_IN_EMAILS',
      value: 'muted',
      userSubscriptionUuid: USER_UUID,
      checkUserPermissions: true,
    })
    expect(bodyOf(result as { json: unknown }).success).toBe(true)
  })

  it('refuses a read-only session before resolving any scope', async () => {
    const request = { params: {}, body: { name: 'MUTE_SIGN_IN_EMAILS', value: 'muted' } } as unknown as Request
    const response = {
      locals: { user: { uuid: USER_UUID, email: 'x@y.tld' }, readOnlyAccess: true },
    } as unknown as Response

    await createController().updateSubscriptionSetting(request, response)

    expect(resolveFileQuotaScope.execute).not.toHaveBeenCalled()
    expect(setSubscriptionSettingValue.execute).not.toHaveBeenCalled()
  })
})
