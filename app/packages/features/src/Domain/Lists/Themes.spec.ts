import { RoleName } from '@standardnotes/domain-core'
import { NativeFeatureIdentifier } from '../Feature/NativeFeatureIdentifier'
import { PermissionName } from '../Permission/PermissionName'
import { themes } from './Themes'

describe('built-in themes', () => {
  it('registers Standard Red as a complete, dark, core-user theme', () => {
    const standardRed = themes().find((theme) => theme.identifier === NativeFeatureIdentifier.TYPES.StandardRedTheme)

    expect(standardRed).toMatchObject({
      name: 'Standard Red',
      identifier: 'org.standardnotes.theme-standard-red',
      permission_name: PermissionName.StandardRedTheme,
      index_path: 'index.css',
      isDark: true,
      dock_icon: {
        type: 'circle',
        background_color: '#e85f6d',
        foreground_color: '#16090f',
        border_color: '#e85f6d',
      },
    })
    expect(standardRed?.availableInRoles).toEqual([
      RoleName.NAMES.CoreUser,
      RoleName.NAMES.PlusUser,
      RoleName.NAMES.ProUser,
    ])
    expect(NativeFeatureIdentifier.create(NativeFeatureIdentifier.TYPES.StandardRedTheme).isFailed()).toBe(false)
  })
})
