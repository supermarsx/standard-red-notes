import { DomainEventPublisherInterface, EmailBackupRequestedEvent } from '@standardnotes/domain-events'

import { RoleServiceInterface } from '../../Role/RoleServiceInterface'
import { GetUserKeyParams } from '../GetUserKeyParams/GetUserKeyParams'
import { TriggerEmailBackupForUser } from './TriggerEmailBackupForUser'
import { DomainEventFactoryInterface } from '../../Event/DomainEventFactoryInterface'

describe('TriggerEmailBackupForUser', () => {
  let roleService: RoleServiceInterface
  let getUserKeyParamsUseCase: GetUserKeyParams
  let domainEventPublisher: DomainEventPublisherInterface
  let domainEventFactory: DomainEventFactoryInterface
  let emailBackupsEnabled: boolean

  const createUseCase = () =>
    new TriggerEmailBackupForUser(
      roleService,
      getUserKeyParamsUseCase,
      domainEventPublisher,
      domainEventFactory,
      emailBackupsEnabled,
    )

  beforeEach(() => {
    roleService = {} as jest.Mocked<RoleServiceInterface>
    roleService.userHasPermission = jest.fn().mockResolvedValue(true)

    getUserKeyParamsUseCase = {} as jest.Mocked<GetUserKeyParams>
    getUserKeyParamsUseCase.execute = jest.fn().mockResolvedValue({ keyParams: {} })

    domainEventPublisher = {} as jest.Mocked<DomainEventPublisherInterface>
    domainEventPublisher.publish = jest.fn()

    domainEventFactory = {} as jest.Mocked<DomainEventFactoryInterface>
    domainEventFactory.createEmailBackupRequestedEvent = jest.fn().mockReturnValue({} as EmailBackupRequestedEvent)

    emailBackupsEnabled = true
  })

  it('publishes EmailBackupRequestedEvent', async () => {
    const useCase = createUseCase()

    const result = await useCase.execute({ userUuid: '00000000-0000-0000-0000-000000000000' })

    expect(result.isFailed()).toBeFalsy()
  })

  it('returns error if user uuid is invalid', async () => {
    const useCase = createUseCase()

    const result = await useCase.execute({ userUuid: 'invalid-uuid' })

    expect(result.isFailed()).toBe(true)
  })

  it('returns error if user is not permitted for email backups', async () => {
    roleService.userHasPermission = jest.fn().mockResolvedValue(false)
    const useCase = createUseCase()

    const result = await useCase.execute({ userUuid: '00000000-0000-0000-0000-000000000000' })

    expect(result.isFailed()).toBe(true)
  })

  it('does not inspect the user or publish when the operator switch is off', async () => {
    emailBackupsEnabled = false

    const result = await createUseCase().execute({ userUuid: '00000000-0000-0000-0000-000000000000' })

    expect(result.isFailed()).toBe(false)
    expect(roleService.userHasPermission).not.toHaveBeenCalled()
    expect(domainEventPublisher.publish).not.toHaveBeenCalled()
  })
})
