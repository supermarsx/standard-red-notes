import { Result } from '@standardnotes/domain-core'
import { TimerInterface } from '@standardnotes/time'

import { GetRegularSubscriptionForUser } from '../GetRegularSubscriptionForUser/GetRegularSubscriptionForUser'
import { GetSharedSubscriptionForUser } from '../GetSharedSubscriptionForUser/GetSharedSubscriptionForUser'
import { ResolveFileQuotaScope } from './ResolveFileQuotaScope'
import { UserSubscription } from '../../Subscription/UserSubscription'

/**
 * Standard Red Notes: the file-quota scope resolver's own tests.
 *
 * *** WHAT THIS IS GUARDING. ***
 *
 * `FILE_UPLOAD_BYTES_USED` and `FILE_UPLOAD_BYTES_LIMIT` are keyed on a
 * `user_subscriptions` uuid, and on the default `included` entitlement mode no
 * account has such a row. Every reader of those two settings therefore gave up —
 * the write path returned without writing, the self-scoped read answered
 * `{setting: undefined}` — and the usage total did not exist for anybody.
 *
 * So the one property that matters here is that this NEVER FAILS for a
 * well-formed uuid. A resolver that could answer "no scope" would put the defect
 * straight back, which is why the happy path and the row-less path are both
 * asserted on the returned uuid rather than on the absence of an error.
 *
 * `activePlanName` carries the second property: it is set only while the
 * subscription is UNEXPIRED, because an expired subscription's plan default is not
 * what gets enforced — `CreateValetToken` takes its free branch for an expired row
 * and grants unlimited unless an explicit limit setting says otherwise. Reporting
 * the plan default there would overstate a ceiling nothing applies.
 */
describe('ResolveFileQuotaScope', () => {
  const USER_UUID = '11111111-1111-4111-8111-111111111111'
  const REGULAR_UUID = '22222222-2222-4222-8222-222222222222'
  const SHARED_UUID = '33333333-3333-4333-8333-333333333333'

  const NOW = 1_700_000_000_000_000

  let getSharedSubscription: GetSharedSubscriptionForUser
  let getRegularSubscription: GetRegularSubscriptionForUser
  let timer: TimerInterface

  const subscription = (uuid: string, endsAt: number, planName = 'PRO_PLAN'): UserSubscription =>
    ({ uuid, endsAt, planName }) as jest.Mocked<UserSubscription>

  const createUseCase = () => new ResolveFileQuotaScope(getSharedSubscription, getRegularSubscription, timer)

  beforeEach(() => {
    getSharedSubscription = {} as jest.Mocked<GetSharedSubscriptionForUser>
    getSharedSubscription.execute = jest.fn().mockReturnValue(Result.fail('no shared subscription'))

    getRegularSubscription = {} as jest.Mocked<GetRegularSubscriptionForUser>
    getRegularSubscription.execute = jest.fn().mockReturnValue(Result.fail('no regular subscription'))

    timer = {} as jest.Mocked<TimerInterface>
    timer.getTimestampInMicroseconds = jest.fn().mockReturnValue(NOW)
  })

  it('falls back to the user’s own uuid when no subscription row exists', async () => {
    const result = await createUseCase().execute({ userUuid: USER_UUID })

    expect(result.isFailed()).toBeFalsy()
    expect(result.getValue()).toEqual({
      userSubscriptionUuid: USER_UUID,
      backedBySubscriptionRow: false,
    })
  })

  it('does not claim a plan default for an account with no subscription row', async () => {
    const result = await createUseCase().execute({ userUuid: USER_UUID })

    // Absent, not `undefined`-valued and not a plan name: the effective allowance
    // for this account is unlimited, which is what the token minter grants, and a
    // plan default here would report a ceiling nothing enforces.
    expect(result.getValue().activePlanName).toBeUndefined()
  })

  it('uses a live regular subscription and reports its plan as the default source', async () => {
    getRegularSubscription.execute = jest.fn().mockReturnValue(Result.ok(subscription(REGULAR_UUID, NOW + 1)))

    const result = await createUseCase().execute({ userUuid: USER_UUID })

    expect(result.getValue()).toEqual({
      userSubscriptionUuid: REGULAR_UUID,
      backedBySubscriptionRow: true,
      activePlanName: 'PRO_PLAN',
    })
  })

  it('prefers a shared subscription over a regular one, matching the settings controller it serves', async () => {
    getSharedSubscription.execute = jest.fn().mockReturnValue(Result.ok(subscription(SHARED_UUID, NOW + 1)))
    getRegularSubscription.execute = jest.fn().mockReturnValue(Result.ok(subscription(REGULAR_UUID, NOW + 1)))

    const result = await createUseCase().execute({ userUuid: USER_UUID })

    expect(result.getValue().userSubscriptionUuid).toBe(SHARED_UUID)
    // And the regular lookup is not even reached, so the order is the assertion
    // rather than a coincidence of two equal answers.
    expect(getRegularSubscription.execute).not.toHaveBeenCalled()
  })

  /**
   * *** AN EXPIRED ROW KEEPS ITS SCOPE AND LOSES ITS PLAN DEFAULT. ***
   *
   * Both halves matter. The scope must stay on the row, because that is where the
   * account's stored total and any explicit limit already live — and it is the
   * scope `CreateValetToken`'s free branch reads from for an expired
   * subscription, so moving it would make the reported allowance disagree with the
   * enforced one. The plan default must go, because nothing applies it.
   */
  it('keeps an expired subscription’s scope and drops its plan default', async () => {
    getRegularSubscription.execute = jest.fn().mockReturnValue(Result.ok(subscription(REGULAR_UUID, NOW - 1)))

    const result = await createUseCase().execute({ userUuid: USER_UUID })

    expect(result.getValue()).toEqual({
      userSubscriptionUuid: REGULAR_UUID,
      backedBySubscriptionRow: true,
    })
  })

  it('treats a subscription ending exactly now as still live', async () => {
    getRegularSubscription.execute = jest.fn().mockReturnValue(Result.ok(subscription(REGULAR_UUID, NOW)))

    expect((await createUseCase().execute({ userUuid: USER_UUID })).getValue().activePlanName).toBe('PRO_PLAN')
  })

  it('fails only on an unusable uuid, and touches no repository when it does', async () => {
    const result = await createUseCase().execute({ userUuid: 'not-a-uuid' })

    expect(result.isFailed()).toBeTruthy()
    expect(result.getError()).toContain('Could not resolve file quota scope')
    expect(getSharedSubscription.execute).not.toHaveBeenCalled()
    expect(getRegularSubscription.execute).not.toHaveBeenCalled()
  })
})
