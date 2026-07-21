import 'reflect-metadata'

import { AccountDeletionRequestedEvent } from '@standardnotes/domain-events'
import { TimerInterface } from '@standardnotes/time'
import { Mixpanel } from 'mixpanel'

import { AnalyticsActivity } from '../Analytics/AnalyticsActivity'
import { AnalyticsStoreInterface } from '../Analytics/AnalyticsStoreInterface'
import { AnalyticsEntity } from '../Entity/AnalyticsEntity'
import { AnalyticsEntityRepositoryInterface } from '../Entity/AnalyticsEntityRepositoryInterface'
import { StatisticMeasureName } from '../Statistics/StatisticMeasureName'
import { StatisticsStoreInterface } from '../Statistics/StatisticsStoreInterface'
import { Period } from '../Time/Period'

import { AccountDeletionRequestedEventHandler } from './AccountDeletionRequestedEventHandler'

describe('AccountDeletionRequestedEventHandler', () => {
  let analyticsEntityRepository: AnalyticsEntityRepositoryInterface
  let analyticsStore: AnalyticsStoreInterface
  let statisticsStore: StatisticsStoreInterface
  let timer: TimerInterface
  let mixpanelClient: Mixpanel | null
  let analyticsEntity: AnalyticsEntity
  let event: AccountDeletionRequestedEvent

  const createHandler = () =>
    new AccountDeletionRequestedEventHandler(
      analyticsEntityRepository,
      analyticsStore,
      statisticsStore,
      timer,
      mixpanelClient,
    )

  beforeEach(() => {
    analyticsEntity = { id: 123, userUuid: '1-2-3', username: 'test@test.te' } as jest.Mocked<AnalyticsEntity>

    analyticsEntityRepository = {} as jest.Mocked<AnalyticsEntityRepositoryInterface>
    analyticsEntityRepository.findOneByUserUuid = jest.fn().mockResolvedValue(analyticsEntity)
    analyticsEntityRepository.remove = jest.fn().mockResolvedValue(undefined)

    analyticsStore = {} as jest.Mocked<AnalyticsStoreInterface>
    analyticsStore.markActivity = jest.fn().mockResolvedValue(undefined)

    statisticsStore = {} as jest.Mocked<StatisticsStoreInterface>
    statisticsStore.incrementMeasure = jest.fn().mockResolvedValue(undefined)

    timer = {} as jest.Mocked<TimerInterface>
    timer.getTimestampInMicroseconds = jest.fn().mockReturnValue(1_000_000)
    timer.convertMicrosecondsToDate = jest.fn().mockReturnValue(new Date(1))

    mixpanelClient = { track: jest.fn() } as unknown as jest.Mocked<Mixpanel>

    event = {
      type: 'ACCOUNT_DELETION_REQUESTED',
      payload: {
        userUuid: '1-2-3',
        userCreatedAtTimestamp: 400_000,
      },
    } as jest.Mocked<AccountDeletionRequestedEvent>
  })

  it('marks the delete-account activity for today, this week and this month', async () => {
    await createHandler().handle(event)

    expect(analyticsStore.markActivity).toHaveBeenCalledWith([AnalyticsActivity.DeleteAccount], 123, [
      Period.Today,
      Period.ThisWeek,
      Period.ThisMonth,
    ])
  })

  it('records the registration length as now minus the user creation timestamp', async () => {
    await createHandler().handle(event)

    expect(statisticsStore.incrementMeasure).toHaveBeenCalledWith(
      StatisticMeasureName.NAMES.RegistrationLength,
      600_000,
      [Period.Today, Period.ThisWeek, Period.ThisMonth],
    )
  })

  it('removes the analytics entity of the deleted account', async () => {
    await createHandler().handle(event)

    expect(analyticsEntityRepository.remove).toHaveBeenCalledWith(analyticsEntity)
  })

  it('tracks the deletion in mixpanel against the analytics id', async () => {
    await createHandler().handle(event)

    expect((mixpanelClient as Mixpanel).track).toHaveBeenCalledWith('ACCOUNT_DELETION_REQUESTED', {
      distinct_id: '123',
      user_created_at: new Date(1),
    })
    expect(timer.convertMicrosecondsToDate).toHaveBeenCalledWith(400_000)
  })

  it('does nothing at all when the user has no analytics entity', async () => {
    analyticsEntityRepository.findOneByUserUuid = jest.fn().mockResolvedValue(null)

    await createHandler().handle(event)

    expect(analyticsStore.markActivity).not.toHaveBeenCalled()
    expect(statisticsStore.incrementMeasure).not.toHaveBeenCalled()
    expect(analyticsEntityRepository.remove).not.toHaveBeenCalled()
    expect((mixpanelClient as Mixpanel).track).not.toHaveBeenCalled()
  })

  it('still marks activity and removes the entity when no mixpanel client is configured', async () => {
    mixpanelClient = null

    await createHandler().handle(event)

    expect(analyticsStore.markActivity).toHaveBeenCalled()
    expect(analyticsEntityRepository.remove).toHaveBeenCalledWith(analyticsEntity)
  })
})
