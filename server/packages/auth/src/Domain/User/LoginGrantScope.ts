import { createHash } from 'crypto'
import { SettingName, Uuid } from '@standardnotes/domain-core'
import { SettingRepositoryInterface } from '../Setting/SettingRepositoryInterface'
import { AuthenticatorRepositoryInterface } from '../Authenticator/AuthenticatorRepositoryInterface'
import { User } from './User'

export type LoginGrantFlow = 'login' | 'recovery'

/** A verified login grant belongs to one account and its current factor policy. */
export class LoginGrantScope {
  constructor(
    private settings: SettingRepositoryInterface,
    private authenticators: AuthenticatorRepositoryInterface,
  ) {}

  async key(challenge: string, user: User, flow: LoginGrantFlow): Promise<string> {
    const uuid = Uuid.create(user.uuid)
    if (uuid.isFailed()) {
      throw new Error('Invalid login grant account')
    }
    const [mfa, magicLink, authenticators, recoveryCodes] = await Promise.all([
      this.settings.findLastByNameAndUserUuid(SettingName.NAMES.MfaSecret, user.uuid),
      this.settings.findLastByNameAndUserUuid(SettingName.NAMES.MagicLinkEnabled, user.uuid),
      this.authenticators.findByUserUuid(uuid.getValue()),
      flow === 'recovery' ? this.settings.findLastByNameAndUserUuid(SettingName.NAMES.RecoveryCodes, user.uuid) : null,
    ])
    // Stored ciphertext identifies factor changes without decrypting or logging secrets.
    // Authenticator counters deliberately do not participate in policy identity.
    const policy = JSON.stringify({
      flow,
      account: user.uuid,
      authGeneration: user.authGeneration ?? 0,
      workspace: user.workspaceIdentifier ?? 'default',
      password: user.encryptedPassword,
      mfa: mfa?.props.value ?? null,
      magicLink: magicLink?.props.value ?? null,
      recoveryCodes: recoveryCodes?.props.value ?? null,
      authenticators: authenticators
        .map((authenticator) => [
          Buffer.from(authenticator.props.credentialId).toString('base64'),
          Buffer.from(authenticator.props.credentialPublicKey).toString('base64'),
        ])
        .sort((left, right) => left[0].localeCompare(right[0])),
    })
    return `verified-v2:${createHash('sha256').update(policy).digest('hex')}:${challenge}`
  }
}
