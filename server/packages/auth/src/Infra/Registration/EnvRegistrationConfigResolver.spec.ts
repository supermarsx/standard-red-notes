import { RoleName } from '@standardnotes/domain-core'

import { RegistrationConfig } from '../../Domain/Registration/RegistrationConfig'
import { EnvRegistrationConfigResolver, registrationBaselineFromEnv } from './EnvRegistrationConfigResolver'

describe('EnvRegistrationConfigResolver', () => {
  const baseline: RegistrationConfig = {
    defaultRole: RoleName.NAMES.CoreUser,
    domainMode: 'off',
    domainList: [],
  }

  it('returns the baseline when there is no overlay', async () => {
    const resolver = new EnvRegistrationConfigResolver(baseline, () => Promise.resolve(undefined))

    expect(await resolver.resolve()).toEqual(baseline)
  })

  it('lets the persisted overlay win over the env baseline', async () => {
    const resolver = new EnvRegistrationConfigResolver(
      { defaultRole: RoleName.NAMES.CoreUser, domainMode: 'blocklist', domainList: ['env.com'] },
      () => Promise.resolve({ defaultRole: RoleName.NAMES.ProUser, domainMode: 'allowlist', domainList: ['Persisted.COM'] }),
    )

    expect(await resolver.resolve()).toEqual({
      defaultRole: RoleName.NAMES.ProUser,
      domainMode: 'allowlist',
      domainList: ['persisted.com'],
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
      })
    })

    it('falls back to safe defaults for invalid/absent env', () => {
      expect(registrationBaselineFromEnv({ defaultRole: 'ADMIN_USER', domainMode: 'weird', domains: undefined })).toEqual({
        defaultRole: RoleName.NAMES.CoreUser,
        domainMode: 'off',
        domainList: [],
      })
    })
  })
})
