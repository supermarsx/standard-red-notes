import 'reflect-metadata'

import { RoleName } from '@standardnotes/domain-core'

import { User } from '../User/User'

jest.mock('@standardnotes/features', () => {
  const original = jest.requireActual('@standardnotes/features')

  return {
    ...original,
    GetFeatures: jest.fn().mockImplementation(() => [
      {
        identifier: 'org.standardnotes.theme-autobiography',
        permission_name: original.PermissionName.AutobiographyTheme,
        expires_at: 555,
      },
      {
        identifier: 'org.standardnotes.bold-editor',
        permission_name: original.PermissionName.BoldEditor,
        expires_at: 777,
      },
    ]),
  }
})

import { FeatureService } from './FeatureService'

describe('FeatureService', () => {
  let user: User

  const createService = () => new FeatureService()

  beforeEach(() => {
    user = {
      uuid: 'user-1-1-1',
    } as jest.Mocked<User>
  })

  it('should return every feature as non-expiring for online users', async () => {
    const features = await createService().getFeaturesForUser(user)

    expect(features).toEqual([
      expect.objectContaining({
        identifier: 'org.standardnotes.theme-autobiography',
        expires_at: undefined,
        no_expire: true,
        role_name: RoleName.NAMES.ProUser,
      }),
      expect.objectContaining({
        identifier: 'org.standardnotes.bold-editor',
        expires_at: undefined,
        no_expire: true,
        role_name: RoleName.NAMES.ProUser,
      }),
    ])
  })

  it('should return every feature and full roles for offline users', async () => {
    const response = await createService().getFeaturesForOfflineUser('test@test.com')

    expect(response.roles).toEqual([
      RoleName.NAMES.CoreUser,
      RoleName.NAMES.PlusUser,
      RoleName.NAMES.ProUser,
      RoleName.NAMES.InternalTeamUser,
    ])
    expect(response.features).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          identifier: 'org.standardnotes.theme-autobiography',
          no_expire: true,
        }),
      ]),
    )
  })

  it('should grant any feature check', async () => {
    expect(await createService().userIsEntitledToFeature(user, 'unknown-future-feature')).toBe(true)
  })
})
