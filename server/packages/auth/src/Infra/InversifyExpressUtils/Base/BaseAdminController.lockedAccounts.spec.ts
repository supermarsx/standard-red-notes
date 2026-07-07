import 'reflect-metadata'

import { Request, Response } from 'express'
import { RoleName } from '@standardnotes/domain-core'

import { DeleteSetting } from '../../../Domain/UseCase/DeleteSetting/DeleteSetting'
import { GetSetting } from '../../../Domain/UseCase/GetSetting/GetSetting'
import { SetSettingValue } from '../../../Domain/UseCase/SetSettingValue/SetSettingValue'
import { SetUserBanStatus } from '../../../Domain/UseCase/SetUserBanStatus/SetUserBanStatus'
import { CreateSubscriptionToken } from '../../../Domain/UseCase/CreateSubscriptionToken/CreateSubscriptionToken'
import { CreateOfflineSubscriptionToken } from '../../../Domain/UseCase/CreateOfflineSubscriptionToken/CreateOfflineSubscriptionToken'
import { UserRepositoryInterface } from '../../../Domain/User/UserRepositoryInterface'
import { LockRepositoryInterface, LockedAccountEntry } from '../../../Domain/User/LockRepositoryInterface'
import { AuditLogWriterInterface } from '../../../Domain/AuditLog/AuditLogWriterInterface'
import { AuditAction } from '../../../Domain/AuditLog/AuditAction'
import { BaseAdminController } from './BaseAdminController'

describe('BaseAdminController locked-account endpoints', () => {
  let lockRepository: jest.Mocked<LockRepositoryInterface>
  let auditLogWriter: AuditLogWriterInterface
  let request: Request
  let adminResponse: Response
  let nonAdminResponse: Response

  // Construct with the audit-log writer at position 10 and the lock repository
  // as the trailing parameter; everything in between is unused here (undefined).
  const createController = (options?: { withLockRepository?: boolean }) => {
    const lock = options?.withLockRepository === false ? undefined : lockRepository
    return new BaseAdminController(
      {} as DeleteSetting,
      {} as GetSetting,
      {} as UserRepositoryInterface,
      {} as CreateSubscriptionToken,
      {} as CreateOfflineSubscriptionToken,
      {} as SetSettingValue,
      {} as SetUserBanStatus,
      undefined,
      undefined,
      auditLogWriter,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      lock,
    )
  }

  const lockedAccounts: LockedAccountEntry[] = [
    { identifier: 'alice@example.com', counter: 4, captchaCounter: 7, ttlSeconds: 1800, locked: true },
  ]

  beforeEach(() => {
    lockRepository = {
      resetLockCounter: jest.fn().mockResolvedValue(undefined),
      listLockedAccounts: jest.fn().mockResolvedValue(lockedAccounts),
    } as unknown as jest.Mocked<LockRepositoryInterface>

    auditLogWriter = {} as jest.Mocked<AuditLogWriterInterface>
    auditLogWriter.write = jest.fn().mockResolvedValue(undefined)

    request = { params: {}, body: {}, headers: {} } as unknown as Request
    adminResponse = {
      locals: { roles: [{ name: RoleName.NAMES.AdminUser }], user: { uuid: 'admin-1' } },
    } as unknown as Response
    nonAdminResponse = { locals: { roles: [{ name: RoleName.NAMES.CoreUser }] } } as unknown as Response
  })

  describe('getLockedAccounts', () => {
    it('403s for a non-admin', async () => {
      const result = await createController().getLockedAccounts(request, nonAdminResponse)

      expect(result.statusCode).toBe(403)
      expect(lockRepository.listLockedAccounts).not.toHaveBeenCalled()
    })

    it('returns the locked accounts for an admin', async () => {
      const result = await createController().getLockedAccounts(request, adminResponse)

      expect(result.json).toEqual({ available: true, accounts: lockedAccounts })
    })

    it('degrades to available:false when the repository cannot list', async () => {
      lockRepository = { resetLockCounter: jest.fn() } as unknown as jest.Mocked<LockRepositoryInterface>

      const result = await createController().getLockedAccounts(request, adminResponse)

      expect(result.json).toEqual({ available: false, accounts: [] })
    })
  })

  describe('unlockAccount', () => {
    it('403s for a non-admin and does not clear anything', async () => {
      request.body = { identifier: 'alice@example.com' }

      const result = await createController().unlockAccount(request, nonAdminResponse)

      expect(result.statusCode).toBe(403)
      expect(lockRepository.resetLockCounter).not.toHaveBeenCalled()
    })

    it('400s when the identifier is missing', async () => {
      const result = await createController().unlockAccount(request, adminResponse)

      expect(result.statusCode).toBe(400)
      expect(lockRepository.resetLockCounter).not.toHaveBeenCalled()
    })

    it('503s when no lock repository is available', async () => {
      request.body = { identifier: 'alice@example.com' }

      const result = await createController({ withLockRepository: false }).unlockAccount(request, adminResponse)

      expect(result.statusCode).toBe(503)
    })

    it('clears the lock counters and writes an audit entry for an admin', async () => {
      request.body = { identifier: '  alice@example.com  ' }

      const result = await createController().unlockAccount(request, adminResponse)

      expect(lockRepository.resetLockCounter).toHaveBeenCalledWith('alice@example.com')
      expect(auditLogWriter.write).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUuid: 'admin-1',
          action: AuditAction.AccountUnlocked,
          metadata: { identifier: 'alice@example.com' },
        }),
      )
      expect(result.json).toEqual({ success: true, identifier: 'alice@example.com' })
    })
  })
})
