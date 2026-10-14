import { randomUUID } from 'crypto'
import { Repository } from 'typeorm'
import { SettingName, Uuid } from '@standardnotes/domain-core'
import { AuthSessionGenerationService } from './AuthSessionGenerationService'
import { Session } from './Session'
import { SettingRepositoryInterface } from '../Setting/SettingRepositoryInterface'
import { AuthenticatorRepositoryInterface } from '../Authenticator/AuthenticatorRepositoryInterface'
import { TrustedDeviceRepositoryInterface } from '../TrustedDevice/TrustedDeviceRepositoryInterface'
import { AppPasswordRepositoryInterface } from '../AppPassword/AppPasswordRepositoryInterface'
import { UserRepositoryInterface } from '../User/UserRepositoryInterface'
import { GetSetting } from '../UseCase/GetSetting/GetSetting'
import { GetActiveSessionsForUser } from '../UseCase/GetActiveSessionsForUser'
import { DeleteOtherSessionsForUser } from '../UseCase/DeleteOtherSessionsForUser'
import { AuditLogWriterInterface } from '../AuditLog/AuditLogWriterInterface'
import { AuditAction } from '../AuditLog/AuditAction'

export interface AdminMfaStatus {
  totpConfigured: boolean
  securityKeyCount: number
  magicLinkEnabled: boolean
  recoveryCodesAvailable: boolean
  trustedDeviceCount: number
  appPasswordCount: number
  openSessionCount: number
}
export class AdminMfaService {
  constructor(
    private deps: {
      sessions: Repository<Session>
      settings: SettingRepositoryInterface
      authenticators: AuthenticatorRepositoryInterface
      trustedDevices: TrustedDeviceRepositoryInterface
      appPasswords: AppPasswordRepositoryInterface
      users: UserRepositoryInterface
      getSetting: GetSetting
      getSessions: GetActiveSessionsForUser
      revokeSessions: DeleteOtherSessionsForUser
      audit: AuditLogWriterInterface
      generation: AuthSessionGenerationService
    },
  ) {}
  async status(userUuid: string): Promise<AdminMfaStatus | undefined> {
    const uuid = Uuid.create(userUuid)
    if (uuid.isFailed() || !(await this.deps.users.findOneByUuid(uuid.getValue()))) {
      return undefined
    }
    const [totp, recovery, keys, trusted, passwords, sessions, magic] = await Promise.all([
      this.deps.settings.findLastByNameAndUserUuid(SettingName.NAMES.MfaSecret, userUuid),
      this.deps.settings.findLastByNameAndUserUuid(SettingName.NAMES.RecoveryCodes, userUuid),
      this.deps.authenticators.findByUserUuid(uuid.getValue()),
      this.deps.trustedDevices.findByUserUuid(uuid.getValue()),
      this.deps.appPasswords.findByUserUuid(uuid.getValue()),
      this.deps.getSessions.execute({ userUuid }),
      this.deps.getSetting.execute({
        userUuid,
        settingName: SettingName.NAMES.MagicLinkEnabled,
        decrypted: true,
        allowSensitiveRetrieval: true,
      }),
    ])
    return {
      totpConfigured: !!totp?.props.value,
      recoveryCodesAvailable: !!recovery?.props.value,
      securityKeyCount: keys.length,
      magicLinkEnabled: !magic.isFailed() && magic.getValue().decryptedValue === 'true',
      trustedDeviceCount: trusted.length,
      appPasswordCount: passwords.length,
      openSessionCount: sessions.sessions.filter(
        (session) => new Date(session.refreshExpiration).getTime() > Date.now(),
      ).length,
    }
  }
  async reset(userUuid: string, actorUuid: string, ip?: string): Promise<AdminMfaStatus | undefined> {
    const uuid = Uuid.create(userUuid)
    if (uuid.isFailed()) {
      return undefined
    }
    const user = await this.deps.users.findOneByUuid(uuid.getValue())
    if (!user) {
      return undefined
    }
    // A fresh random UUID excludes no real current session: admins revoke their
    // own target session as well. Use the existing durable+ephemeral machinery.
    const revoke = async () => {
      const result = await this.deps.revokeSessions.execute({
        userUuid,
        currentSessionUuid: randomUUID(),
        markAsRevoked: true,
      })
      if (result.isFailed()) {
        throw new Error('Session revocation failed')
      }
    }
    await revoke()
    await this.deps.generation.reset(userUuid, async (manager) => {
      await manager
        .createQueryBuilder()
        .delete()
        .from('settings')
        .where('user_uuid = :userUuid AND name IN (:...names)', {
          userUuid,
          names: [SettingName.NAMES.MfaSecret, SettingName.NAMES.RecoveryCodes, SettingName.NAMES.MagicLinkEnabled],
        })
        .execute()
      for (const table of ['authenticators', 'authenticator_challenges', 'trusted_devices', 'app_passwords']) {
        await manager.createQueryBuilder().delete().from(table).where('user_uuid = :userUuid', { userUuid }).execute()
      }
      await manager
        .createQueryBuilder()
        .delete()
        .from('magic_link_tokens')
        .where('LOWER(TRIM(user_identifier)) IN (:...identifiers)', {
          identifiers: [user.email.toLowerCase(), userUuid],
        })
        .execute()
    })
    await revoke()
    await this.deps.audit.write({
      actorUuid,
      action: AuditAction.MfaReset,
      targetType: 'user',
      targetUuid: userUuid,
      ip,
      metadata: { scope: 'all_factors', sessionsRevoked: true },
    })
    return this.status(userUuid)
  }
}
