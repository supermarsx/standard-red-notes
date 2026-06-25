import 'reflect-metadata'

import { UserRegisteredEvent } from '@standardnotes/domain-events'
import { TimerInterface } from '@standardnotes/time'

import { JobRepositoryInterface } from '../Job/JobRepositoryInterface'
import { PredicateRepositoryInterface } from '../Predicate/PredicateRepositoryInterface'

import { UserRegisteredEventHandler } from './UserRegisteredEventHandler'

describe('UserRegisteredEventHandler', () => {
  let timer: TimerInterface
  let jobRepository: JobRepositoryInterface
  let predicateRepository: PredicateRepositoryInterface

  const createHandler = () => new UserRegisteredEventHandler(timer, jobRepository, predicateRepository)

  beforeEach(() => {
    timer = {} as jest.Mocked<TimerInterface>
    timer.getUTCDateNDaysAhead = jest.fn().mockReturnValue(new Date(2))
    timer.convertDateToMicroseconds = jest.fn().mockReturnValue(123)
    timer.getTimestampInMicroseconds = jest.fn().mockReturnValue(1)

    jobRepository = {} as jest.Mocked<JobRepositoryInterface>
    jobRepository.save = jest.fn()

    predicateRepository = {} as jest.Mocked<PredicateRepositoryInterface>
    predicateRepository.save = jest.fn()
  })

  it('should schedule a job encouraging to enable email backups', async () => {
    await createHandler().handle({ payload: { email: 'test@test.te' } } as jest.Mocked<UserRegisteredEvent>)

    expect(jobRepository.save).toHaveBeenNthCalledWith(1, {
      createdAt: 1,
      name: 'encourage-email-backups',
      scheduledAt: 123,
      status: 'pending',
      userIdentifier: 'test@test.te',
      userIdentifierType: 'email',
    })

    expect(predicateRepository.save).toHaveBeenNthCalledWith(1, {
      authority: 'auth',
      job: expect.any(Promise),
      name: 'email-backups-enabled',
      status: 'pending',
    })
  })

  it('should not schedule paid-tier subscription emails (no paid tier in this fork)', async () => {
    await createHandler().handle({ payload: { email: 'test@test.te' } } as jest.Mocked<UserRegisteredEvent>)

    // Only the email-backups job should be scheduled; no subscription/upsell jobs.
    expect(jobRepository.save).toHaveBeenCalledTimes(1)
    expect(jobRepository.save).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'encourage-subscription-purchasing' }),
    )
  })
})
