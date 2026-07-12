import { RoleName } from '@standardnotes/domain-core'

import {
  DEFAULT_EMAIL_CONFIRMATION_BODY,
  DEFAULT_EMAIL_CONFIRMATION_SUBJECT,
  RegistrationConfig,
} from '../../Domain/Registration/RegistrationConfig'
import { EnvRegistrationConfigResolver, registrationBaselineFromEnv } from './EnvRegistrationConfigResolver'

/** The email-confirmation defaults, spread into expectations to keep them DRY. */
const confirmationDefaults = {
  emailConfirmationEnabled: false,
  emailConfirmationGating: 'block_signin' as const,
  emailConfirmationSubject: DEFAULT_EMAIL_CONFIRMATION_SUBJECT,
  emailConfirmationBody: DEFAULT_EMAIL_CONFIRMATION_BODY,
  emailConfirmationBaseUrl: '',
  // Standard Red Notes: signup-control defaults (invite-only + global-total-cap +
  // time-window), all off/unlimited/open so a stock deploy is unchanged.
  inviteOnly: false,
  maxTotalAccounts: 0,
  signupsOpenAt: null,
  signupsCloseAt: null,
}

describe('EnvRegistrationConfigResolver', () => {
  const baseline: RegistrationConfig = {
    defaultRole: RoleName.NAMES.CoreUser,
    domainMode: 'off',
    domainList: [],
    ...confirmationDefaults,
  }

  it('returns the baseline when there is no overlay', async () => {
    const resolver = new EnvRegistrationConfigResolver(baseline, () => Promise.resolve(undefined))

    expect(await resolver.resolve()).toEqual(baseline)
  })

  it('lets the persisted overlay win over the env baseline', async () => {
    const resolver = new EnvRegistrationConfigResolver(
      {
        defaultRole: RoleName.NAMES.CoreUser,
        domainMode: 'blocklist',
        domainList: ['env.com'],
        ...confirmationDefaults,
      },
      () =>
        Promise.resolve({ defaultRole: RoleName.NAMES.ProUser, domainMode: 'allowlist', domainList: ['Persisted.COM'] }),
    )

    expect(await resolver.resolve()).toEqual({
      defaultRole: RoleName.NAMES.ProUser,
      domainMode: 'allowlist',
      domainList: ['persisted.com'],
      ...confirmationDefaults,
    })
  })

  it('coerces an invalid/admin overlay default role back to CORE_USER', async () => {
    const resolver = new EnvRegistrationConfigResolver(baseline, () =>
      Promise.resolve({ defaultRole: RoleName.NAMES.AdminUser }),
    )

    expect((await resolver.resolve()).defaultRole).toEqual(RoleName.NAMES.CoreUser)
  })

  it('degrades to the baseline when the overlay getter throws', async () => {
    const resolver = new EnvRegistrationConfigResolver(baseline, () => Promise.reject(new Error('unreadable')))

    expect(await resolver.resolve()).toEqual(baseline)
  })

  describe('email confirmation resolution', () => {
    it('lets the persisted overlay enable confirmation + override the templates and gating', async () => {
      const resolver = new EnvRegistrationConfigResolver(baseline, () =>
        Promise.resolve({
          emailConfirmationEnabled: true,
          emailConfirmationGating: 'warn',
          emailConfirmationSubject: 'Verify please',
          emailConfirmationBody: 'Open {{confirmation_url}}',
          emailConfirmationBaseUrl: 'https://notes.example.com/',
        }),
      )

      const resolved = await resolver.resolve()
      expect(resolved.emailConfirmationEnabled).toBe(true)
      expect(resolved.emailConfirmationGating).toBe('warn')
      expect(resolved.emailConfirmationSubject).toBe('Verify please')
      expect(resolved.emailConfirmationBody).toBe('Open {{confirmation_url}}')
      expect(resolved.emailConfirmationBaseUrl).toBe('https://notes.example.com/')
    })

    it('coerces an invalid gating mode + blank templates back to defaults', async () => {
      const resolver = new EnvRegistrationConfigResolver(baseline, () =>
        Promise.resolve({
          emailConfirmationEnabled: true,
          emailConfirmationGating: 'nonsense' as unknown as 'warn',
          emailConfirmationSubject: '   ',
          emailConfirmationBody: '',
        }),
      )

      const resolved = await resolver.resolve()
      expect(resolved.emailConfirmationGating).toBe('block_signin')
      expect(resolved.emailConfirmationSubject).toBe(DEFAULT_EMAIL_CONFIRMATION_SUBJECT)
      expect(resolved.emailConfirmationBody).toBe(DEFAULT_EMAIL_CONFIRMATION_BODY)
    })
  })

  describe('registrationBaselineFromEnv', () => {
    it('parses a valid env baseline', () => {
      expect(
        registrationBaselineFromEnv({
          defaultRole: RoleName.NAMES.VaultsUser,
          domainMode: 'allowlist',
          domains: 'A.com, b.com  c.com',
        }),
      ).toEqual({
        defaultRole: RoleName.NAMES.VaultsUser,
        domainMode: 'allowlist',
        domainList: ['a.com', 'b.com', 'c.com'],
        ...confirmationDefaults,
      })
    })

    it('falls back to safe defaults for invalid/absent env', () => {
      expect(registrationBaselineFromEnv({ defaultRole: 'ADMIN_USER', domainMode: 'weird', domains: undefined })).toEqual(
        {
          defaultRole: RoleName.NAMES.CoreUser,
          domainMode: 'off',
          domainList: [],
          ...confirmationDefaults,
        },
      )
    })

    it('enables confirmation only for the exact string "true"', () => {
      expect(registrationBaselineFromEnv({ emailConfirmationEnabled: 'true' }).emailConfirmationEnabled).toBe(true)
      expect(registrationBaselineFromEnv({ emailConfirmationEnabled: 'TRUE' }).emailConfirmationEnabled).toBe(false)
      expect(registrationBaselineFromEnv({ emailConfirmationEnabled: undefined }).emailConfirmationEnabled).toBe(false)
    })
  })
})
