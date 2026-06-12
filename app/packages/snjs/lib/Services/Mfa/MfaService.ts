import { SettingsService } from '../Settings'
import { FeaturesService } from '../Features/FeaturesService'
import {
  AbstractService,
  InternalEventBusInterface,
  MfaServiceInterface,
  ProtectionsClientInterface,
  EncryptionService,
  ChallengeValidation,
} from '@standardnotes/services'
import { SettingName } from '@standardnotes/domain-core'
import { SNRootKeyParams } from '@standardnotes/encryption'
import { HttpServiceInterface } from '@standardnotes/api'
import { isErrorResponse } from '@standardnotes/responses'

const MagicLinkPaths = {
  status: '/v1/mfa/magic-link/status',
}

export class MfaService extends AbstractService implements MfaServiceInterface {
  constructor(
    private settingsService: SettingsService,
    private featuresService: FeaturesService,
    private protections: ProtectionsClientInterface,
    private encryption: EncryptionService,
    private http: HttpServiceInterface,
    protected override internalEventBus: InternalEventBusInterface,
  ) {
    super(internalEventBus)
  }

  async isMagicLinkEnabled(): Promise<boolean> {
    try {
      const response = await this.http.get<{ enabled?: boolean }>(MagicLinkPaths.status)

      if (isErrorResponse(response)) {
        return false
      }

      return response.data?.enabled === true
    } catch (error) {
      return false
    }
  }

  async setMagicLinkEnabled(enabled: boolean): Promise<void> {
    await this.http.post(MagicLinkPaths.status, { enabled })
  }

  async isMfaActivated(): Promise<boolean> {
    const mfaSetting = await this.settingsService.getDoesSensitiveSettingExist(
      SettingName.create(SettingName.NAMES.MfaSecret).getValue(),
    )
    return mfaSetting != false
  }

  async generateMfaSecret(): Promise<string> {
    return this.settingsService.generateMfaSecret()
  }

  async enableMfa(secret: string, otpToken: string): Promise<void> {
    return this.settingsService.updateMfaSetting(secret, otpToken)
  }

  async disableMfa(): Promise<void> {
    const { success, challengeResponse } = await this.protections.authorizeMfaDisable()

    if (!success) {
      return
    }

    const password = challengeResponse?.getValueForType(ChallengeValidation.AccountPassword).value as string
    const currentRootKey = await this.encryption.computeRootKey(
      password,
      this.encryption.getRootKeyParams() as SNRootKeyParams,
    )
    const serverPassword = currentRootKey.serverPassword

    return await this.settingsService.deleteSetting(
      SettingName.create(SettingName.NAMES.MfaSecret).getValue(),
      serverPassword,
    )
  }

  override deinit(): void {
    ;(this.settingsService as unknown) = undefined
    ;(this.featuresService as unknown) = undefined
    ;(this.http as unknown) = undefined
    super.deinit()
  }
}
