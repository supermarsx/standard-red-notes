import 'reflect-metadata'

import { UserRegisteredEvent } from '@standardnotes/domain-events'
import { Mixpanel } from 'mixpanel'

import { AnalyticsActivity } from '../Analytics/AnalyticsActivity'
import { AnalyticsStoreInterface } from '../Analytics/AnalyticsStoreInterface'
import { AnalyticsEntity } from '../Entity/AnalyticsEntity'
import { AnalyticsEntityRepositoryInterface } from '../Entity/AnalyticsEntityRepositoryInterface'
import { Period } from '../Time/Period'

import { UserRegisteredEventHandler } from './UserRegisteredEventHandler'

describe('UserRegisteredEventHandler', () => {
  let analyticsEntityRepository: AnalyticsEntityRepositoryInterface
  let analyticsStore: AnalyticsStoreInterface
  let mixpanelClient: Mixpanel | null
  let event: UserRegisteredEvent

  const createHandler = () => new UserRegisteredEventHandler(analyticsEntityRepository, analyticsStore, mixpanelClient)

  beforeEach(() => {
    analyticsEntityRepository = {} as jest.Mocked<AnalyticsEntityRepositoryInterface>
    analyticsEntityRepository.save = jest
      .fn()
      .mockImplementation(async (entity: AnalyticsEntity) => ({ ...entity, id: 321 }))

    analyticsStore = {} as jest.Mocked<AnalyticsStoreInterface>
    analyticsStore.markActivity = jest.fn().mockResolvedValue(undefined)

    mixpanelClient = { track: jest.fn(), people: { set: jest.fn() } } as unknown as jest.Mocked<Mixpanel>

    event = {
      type: 'USER_REGISTERED',
      payload: { userUuid: '1-2-3', email: 'test@test.te', protocolVersion: '004' },
    } as jest.Mocked<UserRegisteredEvent>
  })

  it('creates an analytics entity carrying the uuid and email from the event', async () => {
    await createHandler().handle(event)

    const saved = (analyticsEntityRepository.save as jest.Mock).mock.calls[0][0]
    expect(saved).toBeInstanceOf(AnalyticsEntity)
    expect(saved.userUuid).toEqual('1-2-3')
    expect(saved.username).toEqual('test@test.te')
  })

  it('marks the register activity against the id assigned when persisting', async () => {
    await createHandler().handle(event)

    expect(analyticsStore.markActivity).toHaveBeenCalledWith([AnalyticsActivity.Register], 321, [
      Period.Today,
      Period.ThisWeek,
      Period.ThisMonth,
    ])
  })

  it('creates a free-plan mixpanel profile for the new user', async () => {
    await createHandler().handle(event)

    expect((mixpanelClient as Mixpanel).track).toHaveBeenCalledWith('USER_REGISTERED', {
      distinct_id: '321',
      protocol_version: '004',
    })
    expect((mixpanelClient as Mixpanel).people.set).toHaveBeenCalledWith('321', {
      subscription: 'free',
      protocol_version: '004',
    })
  })

  it('still persists and marks the registration when no mixpanel client is configured', async () => {
    mixpanelClient = null

    await createHandler().handle(event)

    expect(analyticsEntityRepository.save).toHaveBeenCalled()
    expect(analyticsStore.markActivity).toHaveBeenCalled()
  })
})
