import 'reflect-metadata'

import { Result, SettingName } from '@standardnotes/domain-core'
import { Request, Response } from 'express'

import { BaseSettingsController } from './BaseSettingsController'
import { AuditAction } from '../../../Domain/AuditLog/AuditAction'
import { AuditLogWriterInterface, AuditLogWriteParams } from '../../../Domain/AuditLog/AuditLogWriterInterface'

/**
 * Standard Red Notes: a user changing their OWN sensitive settings is a
 * security event. Only the setting NAME is ever recorded — the value is a
 * secret (TOTP seed, backup app password, extension key) and must never reach
 * a log that an administrator reads and can export.
 */
describe('BaseSettingsController — sensitive setting audit', () => {
  const user = { uuid: 'user-1', email: 'user@example.com' }

  let auditLogWriter: jest.Mocked<AuditLogWriterInterface>
  let setSettingValue: { execute: jest.Mock }
  let doDeleteSetting: { execute: jest.Mock }
  let validateMfaToken: { execute: jest.Mock }
  let settingsAssociationService: { getSensitivityForSetting: jest.Mock }
  let controller: BaseSettingsController

  const response = (): Response =>
    ({
      locals: { user, readOnlyAccess: false, authTokenVersion: 1 },
      setHeader: jest.fn(),
    }) as unknown as Response

  const settingResult = (name: string, sensitive: boolean) => Result.ok({ props: { name, sensitive } })

  beforeEach(() => {
    auditLogWriter = { write: jest.fn().mockResolvedValue(undefined) }
    setSettingValue = { execute: jest.fn().mockResolvedValue(settingResult(SettingName.NAMES.MfaSecret, true)) }
    doDeleteSetting = { execute: jest.fn().mockResolvedValue({ success: true }) }
    validateMfaToken = { execute: jest.fn().mockResolvedValue(Result.ok()) }
    settingsAssociationService = { getSensitivityForSetting: jest.fn().mockReturnValue(true) }

    controller = new BaseSettingsController(
      { execute: jest.fn().mockResolvedValue(Result.ok({ settings: [], subscriptionSettings: [] })) } as never,
      { execute: jest.fn().mockResolvedValue(Result.fail('not found')) } as never,
      setSettingValue as never,
      { execute: jest.fn().mockResolvedValue(Result.ok(undefined)) } as never,
      doDeleteSetting as never,
      {} as never,
      validateMfaToken as never,
      { toProjection: jest.fn().mockReturnValue({}) } as never,
      {} as never,
      { error: jest.fn() } as never,
      auditLogWriter,
      settingsAssociationService as never,
    )
  })

  it('records turning 2FA on under its own action, with the setting name only', async () => {
    await controller.updateSetting(
      {
        params: { userUuid: user.uuid },
        body: { name: SettingName.NAMES.MfaSecret, value: 'the-totp-seed', totpToken: '123456' },
        headers: { 'x-origin-ip': '198.51.100.4' },
      } as unknown as Request,
      response(),
    )

    expect(auditLogWriter.write).toHaveBeenCalledWith({
      actorUuid: user.uuid,
      action: AuditAction.MfaEnabled,
      targetType: 'setting',
      targetUuid: user.uuid,
      ip: '198.51.100.4',
      metadata: { name: SettingName.NAMES.MfaSecret, selfInitiated: true },
    })
  })

  it('records turning 2FA off', async () => {
    await controller.deleteSetting(
      {
        params: { userUuid: user.uuid, settingName: SettingName.NAMES.MfaSecret },
        headers: {},
      } as unknown as Request,
      response(),
    )

    expect(auditLogWriter.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.MfaDisabled,
        metadata: { name: SettingName.NAMES.MfaSecret, selfInitiated: true },
      }),
    )
  })

  it('records a REJECTED 2FA change — the stronger signal — and does not write the setting', async () => {
    validateMfaToken.execute.mockResolvedValueOnce(Result.fail('Invalid TOTP token.'))

    await controller.updateSetting(
      {
        params: { userUuid: user.uuid },
        body: { name: SettingName.NAMES.MfaSecret, value: 'the-totp-seed', totpToken: '000000' },
        headers: {},
      } as unknown as Request,
      response(),
    )

    expect(setSettingValue.execute).not.toHaveBeenCalled()
    expect(auditLogWriter.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.MfaChangeFailed,
        metadata: { name: SettingName.NAMES.MfaSecret, enabling: true },
      }),
    )
  })

  it('records a non-MFA sensitive setting write as a generic setting change', async () => {
    setSettingValue.execute.mockResolvedValueOnce(settingResult(SettingName.NAMES.DropboxBackupToken, true))

    await controller.updateSetting(
      {
        params: { userUuid: user.uuid },
        body: { name: SettingName.NAMES.DropboxBackupToken, value: 'hunter2' },
        headers: {},
      } as unknown as Request,
      response(),
    )

    expect(auditLogWriter.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.SettingChanged,
        metadata: { name: SettingName.NAMES.DropboxBackupToken, selfInitiated: true },
      }),
    )
  })

  it('records a sensitive setting deletion', async () => {
    await controller.deleteSetting(
      {
        params: { userUuid: user.uuid, settingName: SettingName.NAMES.DropboxBackupToken },
        headers: {},
      } as unknown as Request,
      response(),
    )

    expect(auditLogWriter.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.SettingDeleted,
        metadata: { name: SettingName.NAMES.DropboxBackupToken, selfInitiated: true },
      }),
    )
  })

  it('stays quiet for a routine, non-sensitive preference so the log keeps its signal', async () => {
    setSettingValue.execute.mockResolvedValueOnce(settingResult(SettingName.NAMES.EmailBackupFrequency, false))
    settingsAssociationService.getSensitivityForSetting.mockReturnValue(false)

    await controller.updateSetting(
      {
        params: { userUuid: user.uuid },
        body: { name: SettingName.NAMES.EmailBackupFrequency, value: 'daily' },
        headers: {},
      } as unknown as Request,
      response(),
    )
    await controller.deleteSetting(
      {
        params: { userUuid: user.uuid, settingName: SettingName.NAMES.EmailBackupFrequency },
        headers: {},
      } as unknown as Request,
      response(),
    )

    expect(auditLogWriter.write).not.toHaveBeenCalled()
  })

  it('writes nothing when the setting write itself fails', async () => {
    setSettingValue.execute.mockResolvedValueOnce(Result.fail('invalid setting'))

    await controller.updateSetting(
      {
        params: { userUuid: user.uuid },
        body: { name: SettingName.NAMES.MfaSecret, value: 'x', totpToken: '123456' },
        headers: {},
      } as unknown as Request,
      response(),
    )

    expect(auditLogWriter.write).not.toHaveBeenCalled()
  })

  /**
   * The one that matters: whatever else changes about these events, a secret
   * must never travel into the audit log. Feeds distinctive values through
   * every audited settings path and asserts none of them appear ANYWHERE in a
   * recorded entry — action, target, ip or metadata.
   */
  it('never leaks a submitted secret into any recorded event', async () => {
    const secrets = ['SUPER-SECRET-TOTP-SEED', 'SUPER-SECRET-APP-PASSWORD', '654321', 'x-server-password-value']

    setSettingValue.execute.mockResolvedValue(settingResult(SettingName.NAMES.MfaSecret, true))

    await controller.updateSetting(
      {
        params: { userUuid: user.uuid },
        body: { name: SettingName.NAMES.MfaSecret, value: secrets[0], totpToken: secrets[2] },
        headers: { 'x-server-password': secrets[3] },
      } as unknown as Request,
      response(),
    )

    setSettingValue.execute.mockResolvedValue(settingResult(SettingName.NAMES.DropboxBackupToken, true))
    await controller.updateSetting(
      {
        params: { userUuid: user.uuid },
        body: { name: SettingName.NAMES.DropboxBackupToken, value: secrets[1] },
        headers: { 'x-server-password': secrets[3] },
      } as unknown as Request,
      response(),
    )

    await controller.deleteSetting(
      {
        params: { userUuid: user.uuid, settingName: SettingName.NAMES.MfaSecret },
        headers: { 'x-server-password': secrets[3] },
      } as unknown as Request,
      response(),
    )

    validateMfaToken.execute.mockResolvedValueOnce(Result.fail('Invalid TOTP token.'))
    await controller.updateSetting(
      {
        params: { userUuid: user.uuid },
        body: { name: SettingName.NAMES.MfaSecret, value: secrets[0], totpToken: secrets[2] },
        headers: { 'x-server-password': secrets[3] },
      } as unknown as Request,
      response(),
    )

    expect(auditLogWriter.write).toHaveBeenCalledTimes(4)

    const recorded = JSON.stringify(auditLogWriter.write.mock.calls.map((call) => call[0] as AuditLogWriteParams))
    for (const secret of secrets) {
      expect(recorded).not.toContain(secret)
    }
  })

  /**
   * The dangerous case is not MFA_SECRET — whose name announces itself — but a
   * setting whose NAME reads innocuous while its VALUE is a credential.
   * EXTENSION_KEY is exactly that. Nothing about the audit path may treat such a
   * setting more loosely than an obviously-secret one.
   */
  it('does not leak the value of a sensitive setting whose name reads innocuous', async () => {
    const secretValue = 'ext-key-a1b2c3d4-NEVER-LOG-ME'
    setSettingValue.execute.mockResolvedValue(settingResult(SettingName.NAMES.ExtensionKey, true))

    await controller.updateSetting(
      {
        params: { userUuid: user.uuid },
        body: { name: SettingName.NAMES.ExtensionKey, value: secretValue },
        headers: {},
      } as unknown as Request,
      response(),
    )

    const recorded = auditLogWriter.write.mock.calls[0][0] as AuditLogWriteParams
    expect(recorded.action).toEqual(AuditAction.SettingChanged)
    expect(JSON.stringify(recorded)).not.toContain(secretValue)
    // The name is the ONLY setting-derived field recorded.
    expect(recorded.metadata).toEqual({ name: SettingName.NAMES.ExtensionKey, selfInitiated: true })
  })

  /**
   * Structural guard rather than a value blocklist: whatever setting is written,
   * the metadata may only ever carry a fixed set of keys, and `name` must equal
   * the setting NAME exactly. A future edit that widened metadata with anything
   * value-derived would fail here even if the value looked harmless in the test.
   */
  it('confines metadata to a fixed set of non-value keys on every audited path', async () => {
    const allowedKeys = ['name', 'selfInitiated', 'enabling']

    setSettingValue.execute.mockResolvedValue(settingResult(SettingName.NAMES.ExtensionKey, true))
    await controller.updateSetting(
      {
        params: { userUuid: user.uuid },
        body: { name: SettingName.NAMES.ExtensionKey, value: 'secret' },
        headers: {},
      } as unknown as Request,
      response(),
    )

    setSettingValue.execute.mockResolvedValue(settingResult(SettingName.NAMES.MfaSecret, true))
    await controller.updateSetting(
      {
        params: { userUuid: user.uuid },
        body: { name: SettingName.NAMES.MfaSecret, value: 'secret', totpToken: '123456' },
        headers: {},
      } as unknown as Request,
      response(),
    )

    await controller.deleteSetting(
      {
        params: { userUuid: user.uuid, settingName: SettingName.NAMES.ExtensionKey },
        headers: {},
      } as unknown as Request,
      response(),
    )

    validateMfaToken.execute.mockResolvedValueOnce(Result.fail('Invalid TOTP token.'))
    await controller.updateSetting(
      {
        params: { userUuid: user.uuid },
        body: { name: SettingName.NAMES.MfaSecret, value: 'secret', totpToken: '000000' },
        headers: {},
      } as unknown as Request,
      response(),
    )

    expect(auditLogWriter.write).toHaveBeenCalledTimes(4)

    const knownSettingNames = Object.values(SettingName.NAMES)
    for (const call of auditLogWriter.write.mock.calls) {
      const metadata = (call[0] as AuditLogWriteParams).metadata as Record<string, unknown>
      for (const key of Object.keys(metadata)) {
        expect(allowedKeys).toContain(key)
      }
      // `name` is a canonical setting name, never a submitted value.
      expect(knownSettingNames).toContain(metadata.name)
    }
  })
})
