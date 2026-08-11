import { RoleName } from '@standardnotes/domain-core'
import { NativeFeatureIdentifier } from '../Feature/NativeFeatureIdentifier'
import { serverFeatures } from './ServerFeatures'

describe('serverFeatures', () => {
  it('advertises Shared Vaults to the canonical capable roles', () => {
    const sharedVaults = serverFeatures().find(
      (feature) => feature.identifier === NativeFeatureIdentifier.TYPES.SharedVaults,
    )

    expect(sharedVaults?.availableInRoles).toEqual([RoleName.NAMES.ProUser, RoleName.NAMES.VaultsUser, 'ADMIN_USER'])
    expect(sharedVaults?.availableInRoles).not.toContain(RoleName.NAMES.CoreUser)
  })
})
