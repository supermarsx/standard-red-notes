import { Result, UseCaseInterface, Uuid } from '@standardnotes/domain-core'
import { TimerInterface } from '@standardnotes/time'

import { FileQuotaScope } from './FileQuotaScope'
import { ResolveFileQuotaScopeDTO } from './ResolveFileQuotaScopeDTO'
import { GetRegularSubscriptionForUser } from '../GetRegularSubscriptionForUser/GetRegularSubscriptionForUser'
import { GetSharedSubscriptionForUser } from '../GetSharedSubscriptionForUser/GetSharedSubscriptionForUser'

/**
 * Standard Red Notes: resolve the one subscription uuid an account's file-quota
 * settings live under, and the plan default that applies when no explicit
 * allowance has been written.
 *
 * *** THE FALLBACK IS THE WHOLE POINT, AND IT NEVER FAILS. ***
 *
 * Every other reader of these two settings gives up when there is no
 * `user_subscriptions` row — `GetRegularSubscriptionForUser` answers
 * `Result.fail`, `UpdateStorageQuotaUsedForUser` returns without writing and the
 * self-scoped settings controller answers `200 {setting: undefined}`. On the
 * default `included` entitlement mode NO account has such a row, so the usage
 * total was never written and never readable. This use case always succeeds for a
 * well-formed uuid: the row's uuid when one exists, the USER's own uuid when none
 * does.
 *
 * The ORDER mirrors `GetSharedOrRegularSubscriptionForUser` (shared first, then
 * regular) so that no account which already has a row changes scope. The one
 * residual divergence is deliberate and recorded rather than silently fixed: a
 * SHARED subscriber's valet token reads its byte figures from the share OWNER's
 * regular subscription (`CreateValetToken.getMostRecentSubscription`) while this
 * scope — like the settings controller it serves — reads the invitee's own shared
 * row. `UpdateStorageQuotaUsedForUser` writes BOTH, so both carry the same total;
 * what can differ is the explicit LIMIT, and changing the read order here would
 * change behaviour for every existing shared subscriber to fix a case this fork
 * does not ship.
 *
 * `activePlanName` is set only while the row is UNEXPIRED, because an expired
 * subscription's plan default is not what gets enforced: `CreateValetToken` takes
 * its free-token branch for an expired row and grants `-1` unless an explicit
 * limit setting says otherwise. Reporting the plan default there would overstate a
 * ceiling nothing applies.
 */
export class ResolveFileQuotaScope implements UseCaseInterface<FileQuotaScope> {
  constructor(
    private getSharedSubscription: GetSharedSubscriptionForUser,
    private getRegularSubscription: GetRegularSubscriptionForUser,
    private timer: TimerInterface,
  ) {}

  async execute(dto: ResolveFileQuotaScopeDTO): Promise<Result<FileQuotaScope>> {
    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(`Could not resolve file quota scope: ${userUuidOrError.getError()}`)
    }
    const userUuid = userUuidOrError.getValue()

    const currentTimestamp = this.timer.getTimestampInMicroseconds()

    const sharedSubscriptionOrError = await this.getSharedSubscription.execute({ userUuid: userUuid.value })
    if (!sharedSubscriptionOrError.isFailed()) {
      const sharedSubscription = sharedSubscriptionOrError.getValue()

      return Result.ok({
        userSubscriptionUuid: sharedSubscription.uuid,
        backedBySubscriptionRow: true,
        ...(sharedSubscription.endsAt < currentTimestamp ? {} : { activePlanName: sharedSubscription.planName }),
      })
    }

    const regularSubscriptionOrError = await this.getRegularSubscription.execute({ userUuid: userUuid.value })
    if (!regularSubscriptionOrError.isFailed()) {
      const regularSubscription = regularSubscriptionOrError.getValue()

      return Result.ok({
        userSubscriptionUuid: regularSubscription.uuid,
        backedBySubscriptionRow: true,
        ...(regularSubscription.endsAt < currentTimestamp ? {} : { activePlanName: regularSubscription.planName }),
      })
    }

    return Result.ok({
      userSubscriptionUuid: userUuid.value,
      backedBySubscriptionRow: false,
    })
  }
}
