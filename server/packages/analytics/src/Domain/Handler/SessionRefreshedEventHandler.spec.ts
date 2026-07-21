import 'reflect-metadata'

import { Result } from '@standardnotes/domain-core'
import { SessionRefreshedEvent } from '@standardnotes/domain-events'
import { Mixpanel } from 'mixpanel'

import { GetUserAnalyticsId } from '../UseCase/GetUserAnalyticsId/GetUserAnalyticsId'
import { GetUserAnalyticsIdResponse } from '../UseCase/GetUserAnalyticsId/GetUserAnalyticsIdResponse'

import { SessionRefreshedEventHandler } from './SessionRefreshedEventHandler'

describe('SessionRefreshedEventHandler', () => {
  let getUserAnalyticsId: GetUserAnalyticsId
  let mixpanelClient: Mixpanel | null
  let event: SessionRefreshedEvent

  const createHandler = () => new SessionRefreshedEventHandler(getUserAnalyticsId, mixpanelClient)

  beforeEach(() => {
    getUserAnalyticsId = {} as jest.Mocked<GetUserAnalyticsId>
    getUserAnalyticsId.execute = jest
      .fn()
      .mockResolvedValue(Result.ok<GetUserAnalyticsIdResponse>({ analyticsId: 456 } as GetUserAnalyticsIdResponse))

    mixpanelClient = { track: jest.fn() } as unknown as jest.Mocked<Mixpanel>

    event = {
      type: 'SESSION_REFRESHED',
      payload: { userUuid: '1-2-3' },
    } as jest.Mocked<SessionRefreshedEvent>
  })

  it('looks the analytics id up by user uuid, not by email', async () => {
    await createHandler().handle(event)

    expect(getUserAnalyticsId.execute).toHaveBeenCalledWith({ userUuid: '1-2-3' })
  })

  it('tracks both the refresh event and a general activity event', async () => {
    await createHandler().handle(event)

    expect((mixpanelClient as Mixpanel).track).toHaveBeenCalledTimes(2)
    expect((mixpanelClient as Mixpanel).track).toHaveBeenNthCalledWith(1, 'SESSION_REFRESHED', { distinct_id: '456' })
    expect((mixpanelClient as Mixpanel).track).toHaveBeenNthCalledWith(2, 'GENERAL_ACTIVITY', { distinct_id: '456' })
  })

  it('tracks nothing when the user has no analytics id', async () => {
    getUserAnalyticsId.execute = jest.fn().mockResolvedValue(Result.fail('not found'))

    await createHandler().handle(event)

    expect((mixpanelClient as Mixpanel).track).not.toHaveBeenCalled()
  })

  it('completes without error when no mixpanel client is configured', async () => {
    mixpanelClient = null

    await expect(createHandler().handle(event)).resolves.toBeUndefined()
  })
})
