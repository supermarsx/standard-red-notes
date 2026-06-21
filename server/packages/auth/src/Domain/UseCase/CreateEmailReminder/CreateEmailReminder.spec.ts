import { EmailReminder } from '../../EmailReminder/EmailReminder'
import { EmailReminderRepositoryInterface } from '../../EmailReminder/EmailReminderRepositoryInterface'

import { CreateEmailReminder } from './CreateEmailReminder'

describe('CreateEmailReminder', () => {
  let emailReminderRepository: EmailReminderRepositoryInterface

  const userUuid = '00000000-0000-0000-0000-000000000000'

  const createUseCase = (maxEmailRemindersPerUser = 100) =>
    new CreateEmailReminder(emailReminderRepository, maxEmailRemindersPerUser)

  beforeEach(() => {
    emailReminderRepository = {} as jest.Mocked<EmailReminderRepositoryInterface>
    emailReminderRepository.save = jest.fn().mockResolvedValue(undefined)
    emailReminderRepository.findByUserUuid = jest.fn().mockResolvedValue([])
  })

  it('should create a reminder from an ISO due time', async () => {
    const dueIso = '2030-01-01T10:00:00.000Z'

    const result = await createUseCase().execute({ userUuid, dueAt: dueIso, message: 'Call mum' })

    expect(result.isFailed()).toBe(false)
    const value = result.getValue()
    expect(value.dueAt).toBe(Date.parse(dueIso))
    expect(value.message).toBe('Call mum')
    expect(value.sent).toBe(false)
    expect(emailReminderRepository.save).toHaveBeenCalledTimes(1)
    const saved = (emailReminderRepository.save as jest.Mock).mock.calls[0][0] as EmailReminder
    expect(saved.props.userUuid).toBe(userUuid)
  })

  it('should accept a numeric epoch-ms due time', async () => {
    const dueMs = 1900000000000

    const result = await createUseCase().execute({ userUuid, dueAt: dueMs, message: 'Ping' })

    expect(result.isFailed()).toBe(false)
    expect(result.getValue().dueAt).toBe(dueMs)
  })

  it('should reject an empty message', async () => {
    const result = await createUseCase().execute({ userUuid, dueAt: Date.now(), message: '   ' })

    expect(result.isFailed()).toBe(true)
    expect(emailReminderRepository.save).not.toHaveBeenCalled()
  })

  it('should reject an invalid due time', async () => {
    const result = await createUseCase().execute({ userUuid, dueAt: 'not-a-date', message: 'x' })

    expect(result.isFailed()).toBe(true)
    expect(emailReminderRepository.save).not.toHaveBeenCalled()
  })

  it('should reject an invalid user uuid', async () => {
    const result = await createUseCase().execute({ userUuid: 'bad', dueAt: Date.now(), message: 'x' })

    expect(result.isFailed()).toBe(true)
  })

  it('should trim and cap the message length', async () => {
    const longMessage = 'a'.repeat(900)

    const result = await createUseCase().execute({ userUuid, dueAt: Date.now(), message: `  ${longMessage}  ` })

    expect(result.isFailed()).toBe(false)
    expect(result.getValue().message.length).toBe(500)
  })

  it('should allow creating a reminder while under the per-user cap', async () => {
    emailReminderRepository.findByUserUuid = jest.fn().mockResolvedValue(new Array(99).fill({}))

    const result = await createUseCase(100).execute({ userUuid, dueAt: Date.now(), message: 'ok' })

    expect(result.isFailed()).toBe(false)
    expect(emailReminderRepository.save).toHaveBeenCalledTimes(1)
  })

  it('should reject creating a reminder when the user is at the per-user cap', async () => {
    emailReminderRepository.findByUserUuid = jest.fn().mockResolvedValue(new Array(100).fill({}))

    const result = await createUseCase(100).execute({ userUuid, dueAt: Date.now(), message: 'over' })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toContain('maximum of 100 email reminders')
    expect(emailReminderRepository.save).not.toHaveBeenCalled()
  })

  it('should reject creating a reminder when the user is over the per-user cap', async () => {
    emailReminderRepository.findByUserUuid = jest.fn().mockResolvedValue(new Array(150).fill({}))

    const result = await createUseCase(100).execute({ userUuid, dueAt: Date.now(), message: 'over' })

    expect(result.isFailed()).toBe(true)
    expect(emailReminderRepository.save).not.toHaveBeenCalled()
  })

  it('should treat a cap of 0 as unlimited (no count query, never rejected)', async () => {
    emailReminderRepository.findByUserUuid = jest.fn().mockResolvedValue(new Array(10000).fill({}))

    const result = await createUseCase(0).execute({ userUuid, dueAt: Date.now(), message: 'unlimited' })

    expect(result.isFailed()).toBe(false)
    expect(emailReminderRepository.findByUserUuid).not.toHaveBeenCalled()
    expect(emailReminderRepository.save).toHaveBeenCalledTimes(1)
  })
})
