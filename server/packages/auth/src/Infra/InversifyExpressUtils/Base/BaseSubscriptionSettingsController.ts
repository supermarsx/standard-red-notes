import { ControllerContainerInterface, MapperInterface, SettingName } from '@standardnotes/domain-core'
import { BaseHttpController, results } from 'inversify-express-utils'
import { Request, Response } from 'express'
import { Logger } from 'winston'
import { ErrorTag } from '@standardnotes/responses'
import { SubscriptionName } from '@standardnotes/common'

import { GetSubscriptionSetting } from '../../../Domain/UseCase/GetSubscriptionSetting/GetSubscriptionSetting'
import { GetSharedOrRegularSubscriptionForUser } from '../../../Domain/UseCase/GetSharedOrRegularSubscriptionForUser/GetSharedOrRegularSubscriptionForUser'
import { SubscriptionSetting } from '../../../Domain/Setting/SubscriptionSetting'
import { SubscriptionSettingHttpRepresentation } from '../../../Mapping/Http/SubscriptionSettingHttpRepresentation'
import { ResponseLocals } from '../ResponseLocals'
import { SetSubscriptionSettingValue } from '../../../Domain/UseCase/SetSubscriptionSettingValue/SetSubscriptionSettingValue'
import { TriggerPostSettingUpdateActions } from '../../../Domain/UseCase/TriggerPostSettingUpdateActions/TriggerPostSettingUpdateActions'
import { ResolveFileQuotaScope } from '../../../Domain/UseCase/ResolveFileQuotaScope/ResolveFileQuotaScope'
import { FileQuotaScope } from '../../../Domain/UseCase/ResolveFileQuotaScope/FileQuotaScope'
import { SubscriptionSettingsAssociationServiceInterface } from '../../../Domain/Setting/SubscriptionSettingsAssociationServiceInterface'

export class BaseSubscriptionSettingsController extends BaseHttpController {
  constructor(
    protected doGetSetting: GetSubscriptionSetting,
    protected getSharedOrRegularSubscription: GetSharedOrRegularSubscriptionForUser,
    protected setSubscriptionSettingValue: SetSubscriptionSettingValue,
    protected triggerPostSettingUpdateActions: TriggerPostSettingUpdateActions,
    protected subscriptionSettingMapper: MapperInterface<SubscriptionSetting, SubscriptionSettingHttpRepresentation>,
    protected logger: Logger,
    private controllerContainer?: ControllerContainerInterface,
    /**
     * Standard Red Notes: the file-quota scope resolver and the plan-default
     * allowance source. Optional so every existing construction of this
     * controller keeps compiling; without them this endpoint behaves exactly as
     * it did before — a row-less account answers `200 {setting: undefined}` and no
     * effective allowance is derived.
     */
    protected resolveFileQuotaScope?: ResolveFileQuotaScope,
    protected subscriptionSettingsAssociationService?: SubscriptionSettingsAssociationServiceInterface,
  ) {
    super()

    if (this.controllerContainer !== undefined) {
      this.controllerContainer.register('auth.users.getSubscriptionSetting', this.getSubscriptionSetting.bind(this))
      this.controllerContainer.register(
        'auth.users.updateSubscriptionSetting',
        this.updateSubscriptionSetting.bind(this),
      )
    }
  }

  /**
   * Standard Red Notes: the SELF-SCOPED subscription-setting read — the only
   * surface through which an account can learn its own file allowance and usage.
   *
   * *** WHY THIS ANSWERED NOTHING ON EVERY DEFAULT DEPLOYMENT. ***
   *
   * `FILE_UPLOAD_BYTES_USED` and `FILE_UPLOAD_BYTES_LIMIT` are keyed on a
   * `user_subscriptions` row. The default entitlement mode on this fork is
   * `included`, under which `Register` never calls `ActivatePremiumFeatures` and
   * no such row is ever created — while `GetUserSubscription` still synthesises a
   * PRO_PLAN subscription for the client. So the account presented as subscribed,
   * `getSharedOrRegularSubscription` failed, and this endpoint returned
   * `200 {setting: undefined}` for BOTH names on every read, for every account,
   * however many files were on disk. The write side failed at the same fork, so
   * there was nothing to read either way.
   *
   * Two changes, and they are deliberately asymmetric:
   *
   *   - The SCOPE falls back to the user's own uuid (`ResolveFileQuotaScope`), the
   *     same identity the write path now uses, so a stored total is found.
   *   - A missing LIMIT is answered with the EFFECTIVE allowance — the plan
   *     default while a subscription is live, otherwise `-1` — because an absent
   *     limit setting was never an absent allowance: `CreateValetToken` falls back
   *     to exactly these values when it mints the upload token. The answer carries
   *     an `origin` saying which it was.
   *
   *   - A missing USAGE total is STILL ABSENT. Nothing is synthesised, because a
   *     fabricated 0 and a measured 0 are different answers: the first would make
   *     "this deployment has lost its upload bookkeeping" permanently
   *     unobservable, which is the one thing a client reading this endpoint needs
   *     to be able to see.
   */
  async getSubscriptionSetting(request: Request, response: Response): Promise<results.JsonResult> {
    const locals = response.locals as ResponseLocals
    const settingName = (request.params.subscriptionSettingName as string).toUpperCase()

    const scope = await this.resolveQuotaScope(locals.user.uuid)
    if (scope === undefined) {
      // In the single-tier, fully-free model there is no real subscription row,
      // so subscription-setting lookups (e.g. file-upload usage) have nothing to
      // read. Respond successfully with no setting instead of 400 so clients
      // treat it as "no usage data" rather than surfacing a request error.
      return this.json({ success: true, setting: undefined })
    }

    const resultOrError = await this.doGetSetting.execute({
      userSubscriptionUuid: scope.userSubscriptionUuid,
      allowSensitiveRetrieval: false,
      settingName,
    })

    if (resultOrError.isFailed()) {
      const effectiveAllowance = await this.effectiveFileUploadBytesLimit(settingName, scope)
      if (effectiveAllowance !== undefined) {
        return this.json({ success: true, setting: effectiveAllowance })
      }

      // A row-less scope keeps the documented contract: an answer, carrying no
      // setting, rather than a request error a client would surface as a failure.
      if (!scope.backedBySubscriptionRow) {
        return this.json({ success: true, setting: undefined })
      }

      return this.json(
        {
          error: {
            message: resultOrError.getError(),
          },
        },
        400,
      )
    }

    const settingAndValue = resultOrError.getValue()

    return this.json({
      success: true,
      setting: { ...this.subscriptionSettingMapper.toProjection(settingAndValue.setting), origin: 'account-setting' },
    })
  }

  /**
   * The scope this account's subscription settings live under, or `undefined`
   * when there is none to be had.
   *
   * `ResolveFileQuotaScope` never fails for a well-formed uuid, so once it is
   * wired `undefined` means only that the uuid itself was unusable. Without it
   * this falls back to the pre-existing shared-or-regular lookup, which is what
   * keeps every older construction of this controller behaving as before.
   */
  private async resolveQuotaScope(userUuid: string): Promise<FileQuotaScope | undefined> {
    if (this.resolveFileQuotaScope !== undefined) {
      const scopeOrError = await this.resolveFileQuotaScope.execute({ userUuid })

      return scopeOrError.isFailed() ? undefined : scopeOrError.getValue()
    }

    const subscriptionOrError = await this.getSharedOrRegularSubscription.execute({ userUuid })
    if (subscriptionOrError.isFailed()) {
      return undefined
    }

    return { userSubscriptionUuid: subscriptionOrError.getValue().uuid, backedBySubscriptionRow: true }
  }

  /**
   * The EFFECTIVE file allowance for a scope that holds no explicit limit row, as
   * a setting projection — or `undefined` when the question does not apply.
   *
   * Only `FILE_UPLOAD_BYTES_LIMIT` is ever derived here. The two values mirror
   * `CreateValetToken` exactly, which is the only thing that makes them worth
   * reporting: the plan default while a subscription is live, `-1` (unlimited)
   * otherwise. `getFileUploadLimit` throws when the plan's role is not seeded, and
   * that throw must not take down a diagnostics read, so an unanswerable plan
   * default reports nothing rather than a guess.
   */
  private async effectiveFileUploadBytesLimit(
    settingName: string,
    scope: FileQuotaScope,
  ): Promise<SubscriptionSettingHttpRepresentation | undefined> {
    if (settingName !== SettingName.NAMES.FileUploadBytesLimit) {
      return undefined
    }

    let value: number | undefined
    let origin: 'plan-default' | 'no-active-subscription'

    if (scope.activePlanName === undefined) {
      value = -1
      origin = 'no-active-subscription'
    } else {
      if (this.subscriptionSettingsAssociationService === undefined) {
        return undefined
      }
      origin = 'plan-default'
      try {
        value = await this.subscriptionSettingsAssociationService.getFileUploadLimit(
          scope.activePlanName as SubscriptionName,
        )
      } catch (error) {
        this.logger.error(
          `Could not determine the default file upload limit for plan ${scope.activePlanName}: ${
            (error as Error).message
          }`,
        )

        return undefined
      }
    }

    return {
      // DERIVED, not stored: there is no row, so there is no row uuid. An empty
      // string rather than a fabricated one, so nothing downstream can mistake
      // this for something it could update or delete by id.
      uuid: '',
      name: SettingName.NAMES.FileUploadBytesLimit,
      value: `${value}`,
      createdAt: 0,
      updatedAt: 0,
      sensitive: false,
      origin,
    }
  }

  async updateSubscriptionSetting(
    request: Request,
    response: Response,
  ): Promise<results.JsonResult | results.StatusCodeResult> {
    const locals = response.locals as ResponseLocals

    if (locals.readOnlyAccess) {
      return this.json(
        {
          error: {
            tag: ErrorTag.ReadOnlyAccess,
            message: 'Session has read-only access.',
          },
        },
        401,
      )
    }

    // The SAME scope the read above uses, so a value written here is a value the
    // read finds. It used to 400 for any account with no subscription row — i.e.
    // for every account on the default entitlement mode — which made the
    // `account-setting` origin unreachable and left these settings permanently
    // unwritable rather than merely unset.
    const scope = await this.resolveQuotaScope(locals.user.uuid)
    if (scope === undefined) {
      return this.json(
        {
          error: {
            message: `Could not find subscription for user with uuid: ${locals.user.uuid}`,
          },
        },
        400,
      )
    }

    const { name, value } = request.body

    const result = await this.setSubscriptionSettingValue.execute({
      settingName: name,
      value,
      userSubscriptionUuid: scope.userSubscriptionUuid,
      checkUserPermissions: true,
    })

    if (result.isFailed()) {
      return this.json(
        {
          error: {
            message: result.getError(),
          },
        },
        400,
      )
    }
    const subscriptionSetting = result.getValue()

    const triggerResult = await this.triggerPostSettingUpdateActions.execute({
      updatedSettingName: subscriptionSetting.props.name,
      userUuid: locals.user.uuid,
      userEmail: locals.user.email,
      unencryptedValue: value,
    })
    if (triggerResult.isFailed()) {
      this.logger.error('Failed to trigger post-setting-update actions.')
    }

    return this.json({
      success: true,
      setting: subscriptionSetting.props.sensitive
        ? undefined
        : this.subscriptionSettingMapper.toProjection(subscriptionSetting),
    })
  }
}
