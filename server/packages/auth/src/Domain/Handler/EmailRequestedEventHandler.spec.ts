import { Result } from '@standardnotes/domain-core'
import { EmailRequestedEvent } from '@standardnotes/domain-events'
import { TimerInterface } from '@standardnotes/time'
import { Logger } from 'winston'

import {
  BackupAttachmentAlreadyDeliveredError,
  BackupAttachmentNotFoundError,
  BackupAttachmentReference,
  BackupAttachmentStorageInterface,
  BackupAttachmentTooLargeError,
  InvalidBackupAttachmentReferenceError,
} from '../Email/BackupAttachmentStorageInterface'
import { EmailSenderInterface } from '../Email/EmailSenderInterface'
import { EmailBackupStateRepositoryInterface } from '../Email/EmailBackupStateRepositoryInterface'
import { EmailBackupDeliveryState, emptyEmailBackupDeliveryState } from '../Email/EmailBackupDeliveryState'
import { GetSetting } from '../UseCase/GetSetting/GetSetting'
import { SetSettingValue } from '../UseCase/SetSettingValue/SetSettingValue'
import { EmailRequestedEventHandler } from './EmailRequestedEventHandler'

describe('EmailRequestedEventHandler', () => {
  let emailSender: jest.Mocked<EmailSenderInterface>
  let backupAttachmentStorage: jest.Mocked<BackupAttachmentStorageInterface>
  let getSetting: jest.Mocked<GetSetting>
  let setSettingValue: jest.Mocked<SetSettingValue>
  let timer: jest.Mocked<TimerInterface>
  let logger: jest.Mocked<Logger>

  const userUuid = '00000000-0000-4000-8000-000000000001'
  const backupBatchId = '00000000-0000-4000-8000-000000000003'
  const reference: BackupAttachmentReference = {
    fileName: '00000000-0000-4000-8000-000000000002.json',
    filePath: 'C:\\owned\\uploads\\backups',
    attachmentFileName: 'SN-Data-2026-07-30.txt',
    attachmentContentType: 'application/json',
    emailSubject: 'Your encrypted backup',
    batchIndex: 1,
    batchCount: 1,
  }
  const event = (overrides: Partial<EmailRequestedEvent['payload']> = {}): EmailRequestedEvent =>
    ({
      type: 'EMAIL_REQUESTED',
      createdAt: new Date('2026-07-30T00:00:00.000Z'),
      meta: {
        correlation: { userIdentifier: 'person@example.com', userIdentifierType: 'email' },
        origin: 'syncing-server',
      },
      payload: {
        userEmail: 'person@example.com',
        messageIdentifier: 'DATA_BACKUP',
        level: 'system',
        subject: 'Your encrypted backup',
        body: '<p>Attached.</p>',
        sender: 'attacker-controlled@example.com',
        backupBatchId,
        attachments: [reference],
        userUuid,
        ...overrides,
      },
    }) as EmailRequestedEvent

  const createHandler = (
    emailBackupsEnabled = true,
    emailBackupStateRepository?: EmailBackupStateRepositoryInterface,
  ) =>
    new EmailRequestedEventHandler(
      emailSender,
      backupAttachmentStorage,
      getSetting,
      setSettingValue,
      timer,
      emailBackupsEnabled,
      logger,
      emailBackupStateRepository,
    )

  const queueDurableBackup = async (): Promise<EmailBackupDeliveryState> => {
    emailSender = { ...emailSender, acceptanceMode: 'durable-queue' }
    await createHandler().handle(event())

    return JSON.parse((setSettingValue.execute.mock.calls.at(-1)?.[0] as { value: string }).value)
  }

  const backupFailureEvent = (): EmailRequestedEvent =>
    event({
      messageIdentifier: 'DATA_BACKUP_FAILED',
      backupBatchId: undefined,
      attachments: undefined,
      subject: 'Backup could not be created',
      body: '<p>Reduce one large item.</p>',
    })

  beforeEach(() => {
    emailSender = {
      acceptanceMode: 'provider',
      isConfigured: jest.fn().mockReturnValue(true),
      sendEmail: jest.fn().mockResolvedValue(true),
      getDeliveryStatus: jest.fn().mockResolvedValue('missing'),
    }

    backupAttachmentStorage = {
      read: jest.fn().mockResolvedValue(Buffer.from('encrypted-backup')),
      markDelivered: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    }

    getSetting = {
      execute: jest.fn().mockResolvedValue(Result.fail('not found')),
    } as unknown as jest.Mocked<GetSetting>

    setSettingValue = {
      execute: jest.fn().mockResolvedValue(Result.ok({} as never)),
    } as unknown as jest.Mocked<SetSettingValue>

    timer = {} as jest.Mocked<TimerInterface>
    timer.getTimestampInMicroseconds = jest.fn().mockReturnValue(1_000_000)
    timer.convertMicrosecondsToMilliseconds = jest.fn().mockReturnValue(1_000)

    logger = {} as jest.Mocked<Logger>
    logger.info = jest.fn()
    logger.warn = jest.fn()
    logger.error = jest.fn()
  })

  it('receipts the exact bytes before recording the completed batch, then advances cadence and cleans up', async () => {
    await createHandler().handle(event())

    expect(backupAttachmentStorage.read).toHaveBeenCalledWith(reference)
    expect(emailSender.sendEmail).toHaveBeenCalledWith(
      'person@example.com',
      'Your encrypted backup',
      '<p>Attached.</p>',
      {
        attachments: [
          {
            filename: 'SN-Data-2026-07-30.txt',
            contentType: 'application/json',
            content: Buffer.from('encrypted-backup'),
          },
        ],
        html: true,
        deliverySource: 'backup',
        deliveryId: expect.stringMatching(/^backup-[0-9a-f]{64}$/),
      },
    )
    expect(backupAttachmentStorage.markDelivered).toHaveBeenCalledWith(reference)
    expect(setSettingValue.execute).toHaveBeenNthCalledWith(1, {
      settingName: 'EMAIL_BACKUP_DELIVERY_STATE',
      value: JSON.stringify({ completed: [{ batchId: backupBatchId, deliveredAt: 1_000 }] }),
      userUuid,
      checkUserPermissions: false,
    })
    expect(setSettingValue.execute).toHaveBeenNthCalledWith(2, {
      settingName: 'EMAIL_BACKUP_LAST_SENT',
      value: '1000',
      userUuid,
      checkUserPermissions: false,
    })
    expect(backupAttachmentStorage.delete).toHaveBeenCalledWith(reference)
    expect(emailSender.sendEmail.mock.invocationCallOrder[0]).toBeLessThan(
      backupAttachmentStorage.markDelivered.mock.invocationCallOrder[0],
    )
    expect(backupAttachmentStorage.markDelivered.mock.invocationCallOrder[0]).toBeLessThan(
      setSettingValue.execute.mock.invocationCallOrder[0],
    )
    expect(setSettingValue.execute.mock.invocationCallOrder[1]).toBeLessThan(
      backupAttachmentStorage.delete.mock.invocationCallOrder[0],
    )
  })

  it('persists a queue receipt but retains source artifacts and cadence after durable queue acceptance', async () => {
    emailSender = { ...emailSender, acceptanceMode: 'durable-queue' }

    await createHandler().handle(event())

    expect(emailSender.sendEmail).toHaveBeenCalledTimes(1)
    expect(backupAttachmentStorage.markDelivered).not.toHaveBeenCalled()
    expect(backupAttachmentStorage.delete).not.toHaveBeenCalled()
    expect(setSettingValue.execute).toHaveBeenCalledTimes(2)
    const pendingState = JSON.parse((setSettingValue.execute.mock.calls[1][0] as { value: string }).value)
    expect(pendingState).toEqual({
      pending: [
        {
          batchId: backupBatchId,
          outcome: 'backup',
          queuedAt: 1_000,
          deliveries: [
            {
              deliveryId: expect.stringMatching(/^backup-[0-9a-f]{64}$/),
              queueAccepted: true,
              reference,
            },
          ],
        },
      ],
      completed: [],
    })
    expect(
      setSettingValue.execute.mock.calls.some(
        ([input]) => (input as { settingName: string }).settingName === 'EMAIL_BACKUP_LAST_SENT',
      ),
    ).toBe(false)
    expect(logger.info).toHaveBeenCalledWith('Email request accepted by the durable queue', {
      codeTag: 'EmailRequestedEventHandler',
      messageIdentifier: 'DATA_BACKUP',
    })
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('delivered')
  })

  it('finalizes a queued backup exactly once after provider acceptance', async () => {
    emailSender = { ...emailSender, acceptanceMode: 'durable-queue' }
    await createHandler().handle(event())
    const pendingValue = (setSettingValue.execute.mock.calls.at(-1)?.[0] as { value: string }).value

    getSetting.execute.mockResolvedValue(Result.ok({ setting: {} as never, decryptedValue: pendingValue }))
    emailSender.getDeliveryStatus?.mockResolvedValue('provider-accepted')
    emailSender.sendEmail.mockClear()

    await createHandler().handle(event())

    expect(emailSender.sendEmail).not.toHaveBeenCalled()
    expect(backupAttachmentStorage.markDelivered).toHaveBeenCalledWith(reference)
    expect(backupAttachmentStorage.delete).toHaveBeenCalledWith(reference)
    expect(setSettingValue.execute.mock.calls.slice(-2).map(([input]) => input)).toEqual([
      {
        settingName: 'EMAIL_BACKUP_DELIVERY_STATE',
        value: JSON.stringify({ completed: [{ batchId: backupBatchId, deliveredAt: 1_000 }] }),
        userUuid,
        checkUserPermissions: false,
      },
      {
        settingName: 'EMAIL_BACKUP_LAST_SENT',
        value: '1000',
        userUuid,
        checkUserPermissions: false,
      },
    ])
  })

  it('persists a recovered queue receipt before finalizing a provider-accepted backup', async () => {
    const pendingState = await queueDurableBackup()
    pendingState.pending[0].deliveries[0].queueAccepted = false
    getSetting.execute.mockResolvedValue(
      Result.ok({ setting: {} as never, decryptedValue: JSON.stringify(pendingState) }),
    )
    emailSender.getDeliveryStatus?.mockResolvedValue('provider-accepted')
    emailSender.sendEmail.mockClear()
    setSettingValue.execute.mockClear()

    await createHandler().handle(event())

    expect(emailSender.sendEmail).not.toHaveBeenCalled()
    expect(backupAttachmentStorage.markDelivered).toHaveBeenCalledWith(reference)
    expect(backupAttachmentStorage.delete).toHaveBeenCalledWith(reference)
    expect(setSettingValue.execute).toHaveBeenCalledTimes(3)
  })

  it('persists a recovered queue receipt while provider delivery remains pending', async () => {
    const pendingState = await queueDurableBackup()
    pendingState.pending[0].deliveries[0].queueAccepted = false
    getSetting.execute.mockResolvedValue(
      Result.ok({ setting: {} as never, decryptedValue: JSON.stringify(pendingState) }),
    )
    emailSender.getDeliveryStatus?.mockResolvedValue('pending')
    emailSender.sendEmail.mockClear()
    setSettingValue.execute.mockClear()

    await createHandler().handle(event())

    expect(emailSender.sendEmail).not.toHaveBeenCalled()
    expect(backupAttachmentStorage.markDelivered).not.toHaveBeenCalled()
    expect(backupAttachmentStorage.delete).not.toHaveBeenCalled()
    expect(setSettingValue.execute).toHaveBeenCalledTimes(1)
  })

  it('fails closed when a durable retry does not match its recorded batch', async () => {
    const pendingState = await queueDurableBackup()
    getSetting.execute.mockResolvedValue(
      Result.ok({ setting: {} as never, decryptedValue: JSON.stringify(pendingState) }),
    )
    emailSender.sendEmail.mockClear()

    await expect(
      createHandler().handle(
        event({
          attachments: [{ ...reference, attachmentFileName: 'different-backup.txt' }],
        }),
      ),
    ).rejects.toThrow('Email backup delivery state does not match the requested batch')

    expect(emailSender.sendEmail).not.toHaveBeenCalled()
    expect(backupAttachmentStorage.delete).not.toHaveBeenCalled()
  })

  it.each(['missing', 'error'] as const)('fails closed when durable status is %s', async (mode) => {
    emailSender = {
      ...emailSender,
      acceptanceMode: 'durable-queue',
      getDeliveryStatus:
        mode === 'missing' ? undefined : jest.fn().mockRejectedValue(new Error('private provider failure')),
    }

    await expect(createHandler().handle(event())).rejects.toThrow(
      mode === 'missing'
        ? 'Durable email delivery status is unavailable'
        : 'Durable email delivery status could not be read',
    )

    expect(emailSender.sendEmail).not.toHaveBeenCalled()
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('private provider failure')
  })

  it('retains a provider-accepted durable backup when its receipt cannot be recorded', async () => {
    const pendingState = await queueDurableBackup()
    getSetting.execute.mockResolvedValue(
      Result.ok({ setting: {} as never, decryptedValue: JSON.stringify(pendingState) }),
    )
    emailSender.getDeliveryStatus?.mockResolvedValue('provider-accepted')
    backupAttachmentStorage.markDelivered.mockRejectedValue(new Error('storage unavailable'))
    emailSender.sendEmail.mockClear()

    await expect(createHandler().handle(event())).rejects.toThrow(
      'Email backup delivery receipt could not be persisted',
    )

    expect(emailSender.sendEmail).not.toHaveBeenCalled()
    expect(backupAttachmentStorage.delete).not.toHaveBeenCalled()
  })

  it('uses the transaction-bound state repository for production durable lifecycle transitions', async () => {
    emailSender = { ...emailSender, acceptanceMode: 'durable-queue' }
    let state: EmailBackupDeliveryState = emptyEmailBackupDeliveryState()
    let lastSentAt: number | undefined
    const stateRepository: EmailBackupStateRepositoryInterface = {
      runExclusive: jest.fn(async (_userUuid, transition) => {
        const mutation = await transition(state)
        if (mutation.deliveryState) {
          state = mutation.deliveryState
        }
        if (mutation.lastSentAt !== undefined) {
          lastSentAt = mutation.lastSentAt
        }
        return { status: 'available', value: mutation.result }
      }),
    }

    await createHandler(true, stateRepository).handle(event())
    expect(state.pending).toHaveLength(1)
    expect(state.pending[0].deliveries[0].queueAccepted).toBe(true)
    expect(lastSentAt).toBeUndefined()

    emailSender.getDeliveryStatus?.mockResolvedValue('provider-accepted')
    emailSender.sendEmail.mockClear()
    await createHandler(true, stateRepository).handle(event())

    expect(emailSender.sendEmail).not.toHaveBeenCalled()
    expect(state.pending).toHaveLength(0)
    expect(state.completed).toEqual([{ batchId: backupBatchId, deliveredAt: 1_000 }])
    expect(lastSentAt).toBe(1_000)
    expect(getSetting.execute).not.toHaveBeenCalled()
    expect(setSettingValue.execute).not.toHaveBeenCalled()
  })

  it.each(['dead', 'quarantined', 'discarded', 'superseded', 'missing'] as const)(
    'retains a queue-accepted backup and raises a redacted alert when delivery becomes %s',
    async (status) => {
      emailSender = { ...emailSender, acceptanceMode: 'durable-queue' }
      await createHandler().handle(event())
      const pendingValue = (setSettingValue.execute.mock.calls.at(-1)?.[0] as { value: string }).value
      const writesBeforeRetry = setSettingValue.execute.mock.calls.length

      getSetting.execute.mockResolvedValue(Result.ok({ setting: {} as never, decryptedValue: pendingValue }))
      emailSender.getDeliveryStatus?.mockResolvedValue(status)
      emailSender.sendEmail.mockClear()

      await expect(createHandler().handle(event())).rejects.toThrow(
        'Email backup durable delivery requires operator attention',
      )

      expect(emailSender.sendEmail).not.toHaveBeenCalled()
      expect(setSettingValue.execute).toHaveBeenCalledTimes(writesBeforeRetry)
      expect(backupAttachmentStorage.markDelivered).not.toHaveBeenCalled()
      expect(backupAttachmentStorage.delete).not.toHaveBeenCalled()
      expect(logger.error).toHaveBeenCalledWith('Email backup durable delivery is blocked', {
        codeTag: 'EmailRequestedEventHandler',
        messageIdentifier: 'DATA_BACKUP',
        batchId: backupBatchId,
        status,
      })
    },
  )

  it('never falls back to direct SMTP while a durable backup receipt is unresolved', async () => {
    emailSender = { ...emailSender, acceptanceMode: 'durable-queue' }
    await createHandler().handle(event())
    const pendingValue = (setSettingValue.execute.mock.calls.at(-1)?.[0] as { value: string }).value

    getSetting.execute.mockResolvedValue(Result.ok({ setting: {} as never, decryptedValue: pendingValue }))
    emailSender = { ...emailSender, acceptanceMode: 'provider' }
    emailSender.sendEmail.mockClear()

    await expect(createHandler().handle(event())).rejects.toThrow(
      'Email backup durable delivery requires operator attention',
    )

    expect(emailSender.sendEmail).not.toHaveBeenCalled()
    expect(backupAttachmentStorage.markDelivered).not.toHaveBeenCalled()
    expect(backupAttachmentStorage.delete).not.toHaveBeenCalled()
  })

  it('sorts a multi-part event and records completion only after every part is receipted', async () => {
    const partOne = {
      ...reference,
      fileName: 'part-one.json',
      attachmentFileName: 'part-one.txt',
      emailSubject: 'Part 1 of 2',
      batchIndex: 1,
      batchCount: 2,
    }
    const partTwo = {
      ...reference,
      fileName: 'part-two.json',
      attachmentFileName: 'part-two.txt',
      emailSubject: 'Part 2 of 2',
      batchIndex: 2,
      batchCount: 2,
    }
    backupAttachmentStorage.read.mockResolvedValueOnce(Buffer.from('one')).mockResolvedValueOnce(Buffer.from('two'))

    await createHandler().handle(event({ attachments: [partTwo, partOne] }))

    expect(backupAttachmentStorage.read.mock.calls.map(([part]) => part.fileName)).toEqual([
      'part-one.json',
      'part-two.json',
    ])
    expect(emailSender.sendEmail.mock.calls.map(([, subject]) => subject)).toEqual(['Part 1 of 2', 'Part 2 of 2'])
    expect(backupAttachmentStorage.markDelivered.mock.calls.map(([part]) => part.fileName)).toEqual([
      'part-one.json',
      'part-two.json',
    ])
    expect(setSettingValue.execute).toHaveBeenCalledTimes(2)
    expect(backupAttachmentStorage.delete).toHaveBeenCalledTimes(2)
  })

  it('uses the owned attachment identity for a legacy single-part backup without a batch id', async () => {
    await createHandler().handle(event({ backupBatchId: undefined }))

    expect(emailSender.sendEmail).toHaveBeenCalledTimes(1)
    expect(setSettingValue.execute).toHaveBeenNthCalledWith(1, {
      settingName: 'EMAIL_BACKUP_DELIVERY_STATE',
      value: JSON.stringify({
        completed: [{ batchId: `legacy-${reference.fileName}`, deliveredAt: 1_000 }],
      }),
      userUuid,
      checkUserPermissions: false,
    })
  })

  it('leaves later parts and bookkeeping untouched when a multi-part SMTP delivery fails', async () => {
    const partOne = {
      ...reference,
      fileName: 'part-one.json',
      attachmentFileName: 'part-one.txt',
      emailSubject: 'Part 1 of 2',
      batchIndex: 1,
      batchCount: 2,
    }
    const partTwo = {
      ...reference,
      fileName: 'part-two.json',
      attachmentFileName: 'part-two.txt',
      emailSubject: 'Part 2 of 2',
      batchIndex: 2,
      batchCount: 2,
    }
    emailSender.sendEmail.mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    await expect(createHandler().handle(event({ attachments: [partOne, partTwo] }))).rejects.toThrow(
      'Email delivery was not confirmed',
    )

    expect(backupAttachmentStorage.markDelivered).toHaveBeenCalledTimes(1)
    expect(backupAttachmentStorage.markDelivered).toHaveBeenCalledWith(partOne)
    expect(setSettingValue.execute).not.toHaveBeenCalled()
    expect(backupAttachmentStorage.delete).not.toHaveBeenCalled()
  })

  it('uses durable part receipts to finish a retry without resending accepted parts', async () => {
    const partOne = {
      ...reference,
      fileName: 'part-one.json',
      attachmentFileName: 'part-one.txt',
      emailSubject: 'Part 1 of 2',
      batchIndex: 1,
      batchCount: 2,
    }
    const partTwo = {
      ...reference,
      fileName: 'part-two.json',
      attachmentFileName: 'part-two.txt',
      emailSubject: 'Part 2 of 2',
      batchIndex: 2,
      batchCount: 2,
    }
    backupAttachmentStorage.read
      .mockRejectedValueOnce(new BackupAttachmentAlreadyDeliveredError())
      .mockResolvedValueOnce(Buffer.from('two'))

    await createHandler().handle(event({ attachments: [partTwo, partOne] }))

    expect(emailSender.sendEmail).toHaveBeenCalledTimes(1)
    expect(emailSender.sendEmail.mock.calls[0][1]).toBe('Part 2 of 2')
    expect(backupAttachmentStorage.markDelivered).toHaveBeenCalledTimes(1)
    expect(backupAttachmentStorage.markDelivered).toHaveBeenCalledWith(partTwo)
    expect(setSettingValue.execute).toHaveBeenCalledTimes(2)
    expect(backupAttachmentStorage.delete).toHaveBeenCalledTimes(2)
  })

  it('replays a completed batch without SMTP and repairs cadence before best-effort cleanup', async () => {
    getSetting.execute.mockResolvedValue(
      Result.ok({
        setting: {} as never,
        decryptedValue: JSON.stringify({
          completed: [{ batchId: backupBatchId, deliveredAt: 777 }],
        }),
      }),
    )

    await createHandler().handle(event())

    expect(backupAttachmentStorage.read).not.toHaveBeenCalled()
    expect(emailSender.sendEmail).not.toHaveBeenCalled()
    expect(setSettingValue.execute).toHaveBeenCalledTimes(1)
    expect(setSettingValue.execute).toHaveBeenCalledWith({
      settingName: 'EMAIL_BACKUP_LAST_SENT',
      value: '777',
      userUuid,
      checkUserPermissions: false,
    })
    expect(backupAttachmentStorage.delete).toHaveBeenCalledWith(reference)
  })

  it('retains prior completed batches when recording a newly delivered batch', async () => {
    const priorBatch = {
      batchId: '00000000-0000-4000-8000-000000000099',
      deliveredAt: 500,
    }
    getSetting.execute.mockResolvedValue(
      Result.ok({
        setting: {} as never,
        decryptedValue: JSON.stringify({ completed: [priorBatch] }),
      }),
    )

    await createHandler().handle(event())

    expect(setSettingValue.execute).toHaveBeenNthCalledWith(1, {
      settingName: 'EMAIL_BACKUP_DELIVERY_STATE',
      value: JSON.stringify({
        completed: [priorBatch, { batchId: backupBatchId, deliveredAt: 1_000 }],
      }),
      userUuid,
      checkUserPermissions: false,
    })
  })

  it('keeps receipts when completed-batch persistence fails so queue retry cannot resend', async () => {
    setSettingValue.execute.mockResolvedValue(Result.fail('database unavailable'))

    await expect(createHandler().handle(event())).rejects.toThrow('Email backup bookkeeping could not be persisted')

    expect(emailSender.sendEmail).toHaveBeenCalledTimes(1)
    expect(backupAttachmentStorage.markDelivered).toHaveBeenCalledWith(reference)
    expect(backupAttachmentStorage.delete).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith('Email backup delivery state could not be recorded', {
      codeTag: 'EmailRequestedEventHandler',
      messageIdentifier: 'DATA_BACKUP',
    })
  })

  it('leaves the attachment in place and rejects so an SMTP failure is retryable', async () => {
    emailSender.sendEmail.mockResolvedValue(false)

    await expect(createHandler().handle(event())).rejects.toThrow('Email delivery was not confirmed')

    expect(backupAttachmentStorage.markDelivered).not.toHaveBeenCalled()
    expect(backupAttachmentStorage.delete).not.toHaveBeenCalled()
    expect(setSettingValue.execute).not.toHaveBeenCalled()
  })

  it('retains a delivered attachment when its direct-delivery receipt cannot be recorded', async () => {
    backupAttachmentStorage.markDelivered.mockRejectedValue(new Error('storage unavailable'))

    await expect(createHandler().handle(event())).rejects.toThrow(
      'Email backup delivery receipt could not be persisted',
    )

    expect(emailSender.sendEmail).toHaveBeenCalledTimes(1)
    expect(backupAttachmentStorage.delete).not.toHaveBeenCalled()
    expect(setSettingValue.execute).not.toHaveBeenCalled()
  })

  it('finishes successful bookkeeping when delivered-source cleanup fails', async () => {
    backupAttachmentStorage.delete.mockRejectedValue(new Error('storage unavailable'))

    await expect(createHandler().handle(event())).resolves.toBeUndefined()

    expect(backupAttachmentStorage.markDelivered).toHaveBeenCalledWith(reference)
    expect(setSettingValue.execute).toHaveBeenCalledTimes(2)
    expect(logger.error).toHaveBeenCalledWith('Delivered email backup attachment could not be deleted', {
      codeTag: 'EmailRequestedEventHandler',
      messageIdentifier: 'DATA_BACKUP',
    })
  })

  it('propagates missing and transient storage reads for queue retry without logging their details', async () => {
    for (const error of [new BackupAttachmentNotFoundError(), new Error('secret storage endpoint')]) {
      backupAttachmentStorage.read.mockRejectedValueOnce(error)

      await expect(createHandler().handle(event())).rejects.toThrow('Email backup attachment could not be read')
    }

    expect(emailSender.sendEmail).not.toHaveBeenCalled()
    expect(backupAttachmentStorage.delete).not.toHaveBeenCalled()
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret storage endpoint')
  })

  it('permanently rejects foreign storage metadata without exposing it in logs', async () => {
    backupAttachmentStorage.read.mockRejectedValue(new InvalidBackupAttachmentReferenceError())
    const hostileReference = { ...reference, filePath: 'attacker-controlled-bucket' }

    await expect(createHandler().handle(event({ attachments: [hostileReference] }))).resolves.toBeUndefined()

    expect(emailSender.sendEmail).not.toHaveBeenCalled()
    expect(backupAttachmentStorage.delete).toHaveBeenCalledWith(hostileReference)
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('attacker-controlled-bucket')
  })

  it('cleans a permanently rejected durable backup without accepting it into the queue', async () => {
    emailSender = { ...emailSender, acceptanceMode: 'durable-queue' }
    backupAttachmentStorage.read.mockRejectedValue(new InvalidBackupAttachmentReferenceError())

    await expect(createHandler().handle(event())).resolves.toBeUndefined()

    expect(emailSender.sendEmail).not.toHaveBeenCalled()
    expect(backupAttachmentStorage.delete).toHaveBeenCalledWith(reference)
  })

  it('blocks a durable backup whose source was already receipted without a queue receipt', async () => {
    emailSender = { ...emailSender, acceptanceMode: 'durable-queue' }
    backupAttachmentStorage.read.mockRejectedValue(new BackupAttachmentAlreadyDeliveredError())

    await expect(createHandler().handle(event())).rejects.toThrow(
      'Email backup durable delivery requires operator attention',
    )

    expect(emailSender.sendEmail).not.toHaveBeenCalled()
    expect(backupAttachmentStorage.delete).not.toHaveBeenCalled()
  })

  it('retains a durable backup when queue acceptance is refused', async () => {
    emailSender = { ...emailSender, acceptanceMode: 'durable-queue' }
    emailSender.sendEmail.mockResolvedValue(false)

    await expect(createHandler().handle(event())).rejects.toThrow('Email delivery was not confirmed')

    expect(backupAttachmentStorage.markDelivered).not.toHaveBeenCalled()
    expect(backupAttachmentStorage.delete).not.toHaveBeenCalled()
  })

  it('deletes an oversized owned artifact and acknowledges without sending', async () => {
    backupAttachmentStorage.read.mockRejectedValue(new BackupAttachmentTooLargeError())

    await expect(createHandler().handle(event())).resolves.toBeUndefined()

    expect(emailSender.sendEmail).not.toHaveBeenCalled()
    expect(backupAttachmentStorage.delete).toHaveBeenCalledWith(reference)
    expect(setSettingValue.execute).not.toHaveBeenCalled()
  })

  it('cleans every source and receipt when a later part is permanently rejected', async () => {
    const partOne = {
      ...reference,
      fileName: 'part-one.json',
      attachmentFileName: 'part-one.txt',
      emailSubject: 'Part 1 of 2',
      batchIndex: 1,
      batchCount: 2,
    }
    const partTwo = {
      ...reference,
      fileName: 'part-two.json',
      attachmentFileName: 'part-two.txt',
      emailSubject: 'Part 2 of 2',
      batchIndex: 2,
      batchCount: 2,
    }
    backupAttachmentStorage.read
      .mockResolvedValueOnce(Buffer.from('one'))
      .mockRejectedValueOnce(new BackupAttachmentTooLargeError())

    await createHandler().handle(event({ attachments: [partOne, partTwo] }))

    expect(emailSender.sendEmail).toHaveBeenCalledTimes(1)
    expect(backupAttachmentStorage.markDelivered).toHaveBeenCalledWith(partOne)
    expect(backupAttachmentStorage.delete.mock.calls.map(([part]) => part.fileName)).toEqual([
      'part-one.json',
      'part-two.json',
    ])
    expect(setSettingValue.execute).not.toHaveBeenCalled()
  })

  it('rejects incomplete, duplicate, or unsafe batch metadata before touching storage', async () => {
    const invalidEvents = [
      event({ attachments: undefined }),
      event({ attachments: 'not-an-array' as never }),
      event({ attachments: [null as never] }),
      event({ backupBatchId: 'not-a-uuid' }),
      event({
        attachments: [
          { ...reference, batchIndex: 1, batchCount: 2 },
          { ...reference, fileName: 'two.json', batchIndex: 1, batchCount: 2 },
        ],
      }),
      event({ attachments: [{ ...reference, attachmentFileName: '../private.txt' }] }),
    ]

    for (const invalidEvent of invalidEvents) {
      await expect(createHandler().handle(invalidEvent)).resolves.toBeUndefined()
    }

    expect(backupAttachmentStorage.read).not.toHaveBeenCalled()
    expect(emailSender.sendEmail).not.toHaveBeenCalled()
  })

  it('delivers ordinary EMAIL_REQUESTED HTML without backup bookkeeping', async () => {
    await createHandler().handle(
      event({
        messageIdentifier: 'SIGN_IN',
        backupBatchId: undefined,
        attachments: undefined,
        userUuid: undefined,
      }),
    )

    expect(backupAttachmentStorage.read).not.toHaveBeenCalled()
    expect(emailSender.sendEmail).toHaveBeenCalledWith(
      'person@example.com',
      'Your encrypted backup',
      '<p>Attached.</p>',
      { html: true, deliveryId: expect.stringMatching(/^domain-email-[0-9a-f]{64}$/) },
    )
    expect(setSettingValue.execute).not.toHaveBeenCalled()
  })

  it.each([
    ['invalid recipient', { userEmail: 'not-an-email' }],
    ['invalid message', { subject: 'unsafe\r\nsubject' }],
  ] as const)('rejects an %s before delivery', async (_reason, overrides) => {
    await expect(createHandler().handle(event(overrides))).resolves.toBeUndefined()

    expect(emailSender.sendEmail).not.toHaveBeenCalled()
    expect(backupAttachmentStorage.read).not.toHaveBeenCalled()
  })

  it.each(['refused', 'provider-error'] as const)('rejects ordinary email when delivery is %s', async (mode) => {
    if (mode === 'refused') {
      emailSender.sendEmail.mockResolvedValue(false)
    } else {
      emailSender.sendEmail.mockRejectedValue(new Error('private provider failure'))
    }

    await expect(
      createHandler().handle(
        event({
          messageIdentifier: 'SIGN_IN',
          backupBatchId: undefined,
          attachments: undefined,
          userUuid: undefined,
        }),
      ),
    ).rejects.toThrow('Email delivery was not confirmed')

    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('private provider failure')
  })

  it('advances cadence only after an oversized-backup failure notice is accepted', async () => {
    const failureEvent = event({
      messageIdentifier: 'DATA_BACKUP_FAILED',
      backupBatchId: undefined,
      attachments: undefined,
      subject: 'Backup could not be created',
      body: '<p>Reduce one large item.</p>',
    })

    await createHandler().handle(failureEvent)

    expect(emailSender.sendEmail).toHaveBeenCalledWith(
      'person@example.com',
      'Backup could not be created',
      '<p>Reduce one large item.</p>',
      {
        html: true,
        deliverySource: 'backup',
        deliveryId: expect.stringMatching(/^backup-event-[0-9a-f]{64}$/),
      },
    )
    expect(setSettingValue.execute).toHaveBeenCalledTimes(1)
    expect(setSettingValue.execute).toHaveBeenCalledWith({
      settingName: 'EMAIL_BACKUP_LAST_SENT',
      value: '1000',
      userUuid,
      checkUserPermissions: false,
    })

    emailSender.sendEmail.mockResolvedValue(false)
    setSettingValue.execute.mockClear()
    await expect(createHandler().handle(failureEvent)).rejects.toThrow('Email delivery was not confirmed')
    expect(setSettingValue.execute).not.toHaveBeenCalled()
  })

  it('does not advance cadence for a queued failure notice until provider acceptance', async () => {
    emailSender = { ...emailSender, acceptanceMode: 'durable-queue' }
    const failureEvent = event({
      messageIdentifier: 'DATA_BACKUP_FAILED',
      backupBatchId: undefined,
      attachments: undefined,
      subject: 'Backup could not be created',
      body: '<p>Reduce one large item.</p>',
    })

    await createHandler().handle(failureEvent)

    expect(setSettingValue.execute).toHaveBeenCalledTimes(2)
    expect(
      setSettingValue.execute.mock.calls.some(
        ([input]) => (input as { settingName: string }).settingName === 'EMAIL_BACKUP_LAST_SENT',
      ),
    ).toBe(false)
    const pendingValue = (setSettingValue.execute.mock.calls.at(-1)?.[0] as { value: string }).value

    getSetting.execute.mockResolvedValue(Result.ok({ setting: {} as never, decryptedValue: pendingValue }))
    emailSender.getDeliveryStatus?.mockResolvedValue('provider-accepted')
    emailSender.sendEmail.mockClear()
    await createHandler().handle(failureEvent)

    expect(emailSender.sendEmail).not.toHaveBeenCalled()
    expect(setSettingValue.execute.mock.calls.slice(-2).map(([input]) => input)).toEqual([
      expect.objectContaining({ settingName: 'EMAIL_BACKUP_DELIVERY_STATE' }),
      expect.objectContaining({ settingName: 'EMAIL_BACKUP_LAST_SENT', value: '1000' }),
    ])
  })

  it('blocks a direct failure notice while any durable backup receipt is pending', async () => {
    const pendingState = await queueDurableBackup()
    getSetting.execute.mockResolvedValue(
      Result.ok({ setting: {} as never, decryptedValue: JSON.stringify(pendingState) }),
    )
    emailSender = { ...emailSender, acceptanceMode: 'provider' }
    emailSender.sendEmail.mockClear()

    await expect(createHandler().handle(backupFailureEvent())).rejects.toThrow(
      'Email backup durable delivery requires operator attention',
    )

    expect(emailSender.sendEmail).not.toHaveBeenCalled()
  })

  it('replays a completed durable failure notice without sending it again', async () => {
    emailSender = { ...emailSender, acceptanceMode: 'durable-queue' }
    await createHandler().handle(backupFailureEvent())
    const pendingState = JSON.parse(
      (setSettingValue.execute.mock.calls.at(-1)?.[0] as { value: string }).value,
    ) as EmailBackupDeliveryState
    const batchId = pendingState.pending[0].batchId
    getSetting.execute.mockResolvedValue(
      Result.ok({
        setting: {} as never,
        decryptedValue: JSON.stringify({ pending: [], completed: [{ batchId, deliveredAt: 777 }] }),
      }),
    )
    emailSender.sendEmail.mockClear()
    setSettingValue.execute.mockClear()

    await createHandler().handle(backupFailureEvent())

    expect(emailSender.sendEmail).not.toHaveBeenCalled()
    expect(setSettingValue.execute).toHaveBeenCalledWith({
      settingName: 'EMAIL_BACKUP_LAST_SENT',
      value: '777',
      userUuid,
      checkUserPermissions: false,
    })
  })

  it('fails closed when a durable failure notice does not match its recorded delivery', async () => {
    emailSender = { ...emailSender, acceptanceMode: 'durable-queue' }
    await createHandler().handle(backupFailureEvent())
    const pendingState = JSON.parse(
      (setSettingValue.execute.mock.calls.at(-1)?.[0] as { value: string }).value,
    ) as EmailBackupDeliveryState
    pendingState.pending[0].deliveries[0].deliveryId = `backup-event-${'a'.repeat(64)}`
    getSetting.execute.mockResolvedValue(
      Result.ok({ setting: {} as never, decryptedValue: JSON.stringify(pendingState) }),
    )
    emailSender.sendEmail.mockClear()

    await expect(createHandler().handle(backupFailureEvent())).rejects.toThrow(
      'Email backup delivery state does not match the requested batch',
    )

    expect(emailSender.sendEmail).not.toHaveBeenCalled()
  })

  it('blocks a queue-accepted failure notice when delivery becomes terminal', async () => {
    emailSender = { ...emailSender, acceptanceMode: 'durable-queue' }
    await createHandler().handle(backupFailureEvent())
    const pendingValue = (setSettingValue.execute.mock.calls.at(-1)?.[0] as { value: string }).value
    getSetting.execute.mockResolvedValue(Result.ok({ setting: {} as never, decryptedValue: pendingValue }))
    emailSender.getDeliveryStatus?.mockResolvedValue('dead')
    emailSender.sendEmail.mockClear()

    await expect(createHandler().handle(backupFailureEvent())).rejects.toThrow(
      'Email backup durable delivery requires operator attention',
    )

    expect(emailSender.sendEmail).not.toHaveBeenCalled()
  })

  it('retains a durable failure notice when queue acceptance is refused', async () => {
    emailSender = { ...emailSender, acceptanceMode: 'durable-queue' }
    emailSender.sendEmail.mockResolvedValue(false)

    await expect(createHandler().handle(backupFailureEvent())).rejects.toThrow('Email delivery was not confirmed')

    expect(
      setSettingValue.execute.mock.calls.some(
        ([input]) => (input as { settingName: string }).settingName === 'EMAIL_BACKUP_LAST_SENT',
      ),
    ).toBe(false)
  })

  it('cleans every queued artifact without sending when backup delivery is disabled', async () => {
    const secondReference = {
      ...reference,
      fileName: 'two.json',
      attachmentFileName: 'two.txt',
      emailSubject: 'Part 2',
      batchIndex: 2,
      batchCount: 2,
    }
    const firstReference = { ...reference, emailSubject: 'Part 1', batchCount: 2 }

    await expect(
      createHandler(false).handle(event({ attachments: [firstReference, secondReference] })),
    ).resolves.toBeUndefined()

    expect(backupAttachmentStorage.read).not.toHaveBeenCalled()
    expect(emailSender.sendEmail).not.toHaveBeenCalled()
    expect(backupAttachmentStorage.delete.mock.calls.map(([part]) => part.fileName)).toEqual([
      reference.fileName,
      'two.json',
    ])
  })

  it.each([undefined, 'not-a-uuid'])('rejects a backup with unattributable user uuid %s', async (uuid) => {
    await expect(createHandler().handle(event({ userUuid: uuid }))).resolves.toBeUndefined()

    expect(backupAttachmentStorage.read).not.toHaveBeenCalled()
    expect(emailSender.sendEmail).not.toHaveBeenCalled()
  })
})
