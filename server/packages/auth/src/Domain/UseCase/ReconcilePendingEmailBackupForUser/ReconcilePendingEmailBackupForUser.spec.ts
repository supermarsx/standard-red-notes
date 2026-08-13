import { Result } from '@standardnotes/domain-core'
import { TimerInterface } from '@standardnotes/time'
import { Logger } from 'winston'

import {
  BackupAttachmentReference,
  BackupAttachmentStorageInterface,
} from '../../Email/BackupAttachmentStorageInterface'
import {
  EmailBackupDeliveryState,
  PendingEmailBackupBatch,
  emptyEmailBackupDeliveryState,
  serializeEmailBackupDeliveryState,
} from '../../Email/EmailBackupDeliveryState'
import { EmailBackupStateRepositoryInterface } from '../../Email/EmailBackupStateRepositoryInterface'
import { EmailDeliveryStatus, EmailSenderInterface } from '../../Email/EmailSenderInterface'
import { GetSetting } from '../GetSetting/GetSetting'
import { SetSettingValue } from '../SetSettingValue/SetSettingValue'
import { ReconcilePendingEmailBackupForUser } from './ReconcilePendingEmailBackupForUser'

describe('ReconcilePendingEmailBackupForUser', () => {
  const userUuid = '00000000-0000-4000-8000-000000000001'
  const reference = (index: number): BackupAttachmentReference => ({
    fileName: `backup-${index}.json`,
    filePath: 'protected-backup-bucket',
    attachmentFileName: `SN-Data-${index}.txt`,
    attachmentContentType: 'application/json',
    batchIndex: index,
    batchCount: 2,
  })
  const deliveryId = (index: number) => `backup-${index.toString(16).padStart(64, '0')}`
  const pendingBatch = (statusesAccepted = true): PendingEmailBackupBatch => ({
    batchId: 'batch-1',
    outcome: 'backup',
    queuedAt: 500,
    deliveries: [1, 2].map((index) => ({
      deliveryId: deliveryId(index),
      queueAccepted: statusesAccepted,
      reference: reference(index),
    })),
  })

  let emailSender: jest.Mocked<EmailSenderInterface>
  let storage: jest.Mocked<BackupAttachmentStorageInterface>
  let getSetting: jest.Mocked<GetSetting>
  let setSettingValue: jest.Mocked<SetSettingValue>
  let timer: jest.Mocked<TimerInterface>
  let logger: jest.Mocked<Logger>

  const createUseCase = (repository?: EmailBackupStateRepositoryInterface) =>
    new ReconcilePendingEmailBackupForUser(emailSender, storage, getSetting, setSettingValue, timer, logger, repository)

  const setState = (pending: PendingEmailBackupBatch[]) => {
    getSetting.execute.mockResolvedValue(
      Result.ok({
        setting: {} as never,
        decryptedValue: serializeEmailBackupDeliveryState({ pending, completed: [] }),
      }),
    )
  }

  beforeEach(() => {
    emailSender = {
      acceptanceMode: 'durable-queue',
      isConfigured: jest.fn().mockResolvedValue(true),
      sendEmail: jest.fn(),
      getDeliveryStatus: jest.fn().mockResolvedValue('pending'),
    }
    storage = {
      read: jest.fn(),
      markDelivered: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    }
    getSetting = {
      execute: jest.fn().mockResolvedValue(Result.fail('not found')),
    } as unknown as jest.Mocked<GetSetting>
    setSettingValue = {
      execute: jest.fn().mockResolvedValue(Result.ok({} as never)),
    } as unknown as jest.Mocked<SetSettingValue>
    timer = {
      getTimestampInMicroseconds: jest.fn().mockReturnValue(1_000_000),
      convertMicrosecondsToMilliseconds: jest.fn().mockReturnValue(1_000),
    } as unknown as jest.Mocked<TimerInterface>
    logger = {
      error: jest.fn(),
    } as unknown as jest.Mocked<Logger>
  })

  it('reports none when no durable delivery state exists', async () => {
    const result = await createUseCase().execute({ userUuid })

    expect(result.isFailed()).toBe(false)
    expect(result.getValue()).toBe('none')
    expect(emailSender.getDeliveryStatus).not.toHaveBeenCalled()
  })

  it('blocks pending receipts when the sender cannot provide durable status', async () => {
    setState([pendingBatch()])
    emailSender = { ...emailSender, acceptanceMode: 'provider', getDeliveryStatus: undefined }

    const result = await createUseCase().execute({ userUuid })

    expect(result.getValue()).toBe('blocked')
    expect(logger.error).toHaveBeenCalledWith(
      'Pending email backup cannot be reconciled without durable delivery status',
      {
        codeTag: 'ReconcilePendingEmailBackupForUser',
        userId: userUuid,
      },
    )
  })

  it('fails closed when persisted delivery state is malformed', async () => {
    getSetting.execute.mockResolvedValue(Result.ok({ setting: {} as never, decryptedValue: 'not-json' }))

    const result = await createUseCase().execute({ userUuid })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toBe('Email backup delivery state could not be read')
    expect(logger.error).toHaveBeenCalledWith('Email backup delivery state is invalid or unavailable', {
      codeTag: 'ReconcilePendingEmailBackupForUser',
      userId: userUuid,
    })
  })

  it('retains the batch and source files while any part is still pending', async () => {
    setState([pendingBatch()])
    emailSender.getDeliveryStatus.mockResolvedValueOnce('provider-accepted').mockResolvedValueOnce('pending')

    const result = await createUseCase().execute({ userUuid })
    expect(result.isFailed()).toBe(false)
    expect(result.getValue()).toBe('pending')

    expect(storage.markDelivered).not.toHaveBeenCalled()
    expect(storage.delete).not.toHaveBeenCalled()
    expect(setSettingValue.execute).not.toHaveBeenCalled()
  })

  it('receipts and cleans every source only after every delivery is provider accepted', async () => {
    const batch = pendingBatch()
    setState([batch])
    emailSender.getDeliveryStatus.mockResolvedValue('provider-accepted')

    const result = await createUseCase().execute({ userUuid })

    expect(result.getValue()).toBe('completed')
    expect(storage.markDelivered.mock.calls.map(([entry]) => entry.fileName)).toEqual([
      'backup-1.json',
      'backup-2.json',
    ])
    expect(setSettingValue.execute).toHaveBeenNthCalledWith(1, {
      userUuid,
      settingName: 'EMAIL_BACKUP_LAST_SENT',
      value: '1000',
      checkUserPermissions: false,
    })
    expect(setSettingValue.execute).toHaveBeenNthCalledWith(2, {
      userUuid,
      settingName: 'EMAIL_BACKUP_DELIVERY_STATE',
      value: JSON.stringify({ completed: [{ batchId: 'batch-1', deliveredAt: 1_000 }] }),
      checkUserPermissions: false,
    })
    expect(storage.delete).toHaveBeenCalledTimes(2)
  })

  it('retains accepted source files when recording an attachment receipt fails', async () => {
    setState([pendingBatch()])
    emailSender.getDeliveryStatus.mockResolvedValue('provider-accepted')
    storage.markDelivered.mockRejectedValue(new Error('storage unavailable'))

    const result = await createUseCase().execute({ userUuid })

    expect(result.isFailed()).toBe(true)
    expect(storage.delete).not.toHaveBeenCalled()
    expect(setSettingValue.execute).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith('Provider-accepted email backup attachment could not be receipted', {
      codeTag: 'ReconcilePendingEmailBackupForUser',
      userId: userUuid,
    })
  })

  it.each([1, 2])('retains accepted source files when legacy bookkeeping write %s fails', async (failedWrite) => {
    setState([pendingBatch()])
    emailSender.getDeliveryStatus.mockResolvedValue('provider-accepted')
    if (failedWrite === 1) {
      setSettingValue.execute.mockResolvedValueOnce(Result.fail('database unavailable'))
    } else {
      setSettingValue.execute
        .mockResolvedValueOnce(Result.ok({} as never))
        .mockRejectedValueOnce(new Error('database unavailable'))
    }

    const result = await createUseCase().execute({ userUuid })

    expect(result.isFailed()).toBe(true)
    expect(storage.delete).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith(
      'Email backup reconciliation bookkeeping could not be persisted',
      expect.objectContaining({
        codeTag: 'ReconcilePendingEmailBackupForUser',
        userId: userUuid,
      }),
    )
  })

  it('completes bookkeeping while treating delivered-source deletion as best effort', async () => {
    setState([pendingBatch()])
    emailSender.getDeliveryStatus.mockResolvedValue('provider-accepted')
    storage.delete.mockRejectedValue(new Error('storage unavailable'))

    const result = await createUseCase().execute({ userUuid })

    expect(result.getValue()).toBe('completed')
    expect(logger.error).toHaveBeenCalledWith('Delivered email backup attachment could not be deleted', {
      codeTag: 'ReconcilePendingEmailBackupForUser',
      userId: userUuid,
    })
  })

  it('reads and finalizes accepted batches inside the transaction-bound state repository', async () => {
    let state: EmailBackupDeliveryState = { pending: [pendingBatch()], completed: [] }
    let lastSentAt: number | undefined
    const repository: EmailBackupStateRepositoryInterface = {
      runExclusive: jest.fn(async (_uuid, transition) => {
        const mutation = await transition(state)
        state = mutation.deliveryState ?? state
        lastSentAt = mutation.lastSentAt ?? lastSentAt
        return { status: 'available', value: mutation.result }
      }),
    }
    emailSender.getDeliveryStatus.mockResolvedValue('provider-accepted')

    const result = await createUseCase(repository).execute({ userUuid })

    expect(result.getValue()).toBe('completed')
    expect(state).toEqual({ pending: [], completed: [{ batchId: 'batch-1', deliveredAt: 1_000 }] })
    expect(lastSentAt).toBe(1_000)
    expect(repository.runExclusive).toHaveBeenCalledTimes(2)
    expect(getSetting.execute).not.toHaveBeenCalled()
    expect(setSettingValue.execute).not.toHaveBeenCalled()
  })

  it('fails closed when the repository user disappears before state can be read', async () => {
    const repository: EmailBackupStateRepositoryInterface = {
      runExclusive: jest.fn(async (_uuid, transition) => {
        await transition(emptyEmailBackupDeliveryState())
        return { status: 'user-not-found' }
      }),
    }

    const result = await createUseCase(repository).execute({ userUuid })

    expect(result.isFailed()).toBe(true)
    expect(emailSender.getDeliveryStatus).not.toHaveBeenCalled()
  })

  it.each(['user-not-found', 'write-error'] as const)(
    'retains receipts when repository finalization ends with %s',
    async (outcome) => {
      const state: EmailBackupDeliveryState = { pending: [pendingBatch()], completed: [] }
      let calls = 0
      const repository: EmailBackupStateRepositoryInterface = {
        runExclusive: jest.fn(async (_uuid, transition) => {
          calls += 1
          const mutation = await transition(state)
          if (calls === 1) {
            return { status: 'available', value: mutation.result }
          }
          if (outcome === 'write-error') {
            throw new Error('database unavailable')
          }
          return { status: 'user-not-found' }
        }),
      }
      emailSender.getDeliveryStatus.mockResolvedValue('provider-accepted')

      const result = await createUseCase(repository).execute({ userUuid })

      expect(result.isFailed()).toBe(true)
      expect(storage.delete).not.toHaveBeenCalled()
      if (outcome === 'write-error') {
        expect(logger.error).toHaveBeenCalledWith('Email backup reconciliation bookkeeping could not be persisted', {
          codeTag: 'ReconcilePendingEmailBackupForUser',
          userId: userUuid,
        })
      }
    },
  )

  it.each<EmailDeliveryStatus>(['dead', 'quarantined', 'discarded', 'superseded', 'missing'])(
    'fails closed and alerts on %s after queue acceptance',
    async (status) => {
      setState([pendingBatch()])
      emailSender.getDeliveryStatus.mockResolvedValueOnce(status).mockResolvedValueOnce('pending')

      const result = await createUseCase().execute({ userUuid })

      expect(result.getValue()).toBe('blocked')
      expect(setSettingValue.execute).not.toHaveBeenCalled()
      expect(storage.delete).not.toHaveBeenCalled()
      expect(logger.error).toHaveBeenCalledWith('Pending email backup durable delivery is blocked', {
        codeTag: 'ReconcilePendingEmailBackupForUser',
        userId: userUuid,
        batchId: 'batch-1',
        status,
      })
    },
  )

  it('alerts and fails closed when a planned delivery is still missing from the durable queue', async () => {
    setState([pendingBatch(false)])
    emailSender.getDeliveryStatus.mockResolvedValue('missing')

    const result = await createUseCase().execute({ userUuid })

    expect(result.getValue()).toBe('blocked')
    expect(logger.error).toHaveBeenCalledWith('Pending email backup durable delivery is blocked', {
      codeTag: 'ReconcilePendingEmailBackupForUser',
      userId: userUuid,
      batchId: 'batch-1',
      status: 'missing',
    })
  })

  it('does not advance a failure notice until its deterministic delivery is provider accepted', async () => {
    const batch: PendingEmailBackupBatch = {
      batchId: `failure-backup-event-${'a'.repeat(64)}`,
      outcome: 'failure-notice',
      queuedAt: 500,
      deliveries: [{ deliveryId: `backup-event-${'a'.repeat(64)}`, queueAccepted: true }],
    }
    setState([batch])
    emailSender.getDeliveryStatus.mockResolvedValue('pending')

    expect((await createUseCase().execute({ userUuid })).getValue()).toBe('pending')
    expect(setSettingValue.execute).not.toHaveBeenCalled()

    emailSender.getDeliveryStatus.mockResolvedValue('provider-accepted')
    expect((await createUseCase().execute({ userUuid })).getValue()).toBe('completed')
    expect(setSettingValue.execute).toHaveBeenCalledWith(
      expect.objectContaining({ settingName: 'EMAIL_BACKUP_LAST_SENT' }),
    )
  })

  it('redacts delivery adapter failures and retains all state', async () => {
    setState([pendingBatch()])
    emailSender.getDeliveryStatus.mockRejectedValue(new Error('redis://user:secret@private'))

    const result = await createUseCase().execute({ userUuid })

    expect(result.isFailed()).toBe(true)
    expect(setSettingValue.execute).not.toHaveBeenCalled()
    expect(storage.delete).not.toHaveBeenCalled()
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret')
  })
})
