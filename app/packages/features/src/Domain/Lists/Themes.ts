import { ThemeFeatureDescription } from '../Feature/ThemeFeatureDescription'
import { PermissionName } from '../Permission/PermissionName'
import { NativeFeatureIdentifier } from '../Feature/NativeFeatureIdentifier'
import { FillThemeComponentDefaults } from './Utilities/FillThemeComponentDefaults'
import { RoleName } from '@standardnotes/domain-core'

export function themes(): ThemeFeatureDescription[] {
  const midnight: ThemeFeatureDescription = FillThemeComponentDefaults({
    name: 'Midnight',
    identifier: NativeFeatureIdentifier.TYPES.MidnightTheme,
    permission_name: PermissionName.MidnightTheme,
    isDark: true,
    dock_icon: {
      type: 'circle',
      background_color: '#086DD6',
      foreground_color: '#ffffff',
      border_color: '#086DD6',
    },
    availableInRoles: [RoleName.NAMES.PlusUser, RoleName.NAMES.ProUser],
  })

  const futura: ThemeFeatureDescription = FillThemeComponentDefaults({
    availableInRoles: [RoleName.NAMES.PlusUser, RoleName.NAMES.ProUser],
    name: 'Futura',
    identifier: NativeFeatureIdentifier.TYPES.FuturaTheme,
    permission_name: PermissionName.FuturaTheme,
    isDark: true,
    dock_icon: {
      type: 'circle',
      background_color: '#fca429',
      foreground_color: '#ffffff',
      border_color: '#fca429',
    },
  })

  const solarizedDark: ThemeFeatureDescription = FillThemeComponentDefaults({
    availableInRoles: [RoleName.NAMES.PlusUser, RoleName.NAMES.ProUser],
    name: 'Solarized Dark',
    identifier: NativeFeatureIdentifier.TYPES.SolarizedDarkTheme,
    permission_name: PermissionName.SolarizedDarkTheme,
    isDark: true,
    dock_icon: {
      type: 'circle',
      background_color: '#2AA198',
      foreground_color: '#ffffff',
      border_color: '#2AA198',
    },
  })

  const autobiography: ThemeFeatureDescription = FillThemeComponentDefaults({
    availableInRoles: [RoleName.NAMES.PlusUser, RoleName.NAMES.ProUser],
    name: 'Autobiography',
    identifier: NativeFeatureIdentifier.TYPES.AutobiographyTheme,
    permission_name: PermissionName.AutobiographyTheme,
    dock_icon: {
      type: 'circle',
      background_color: '#9D7441',
      foreground_color: '#ECE4DB',
      border_color: '#9D7441',
    },
  })

  const dark: ThemeFeatureDescription = FillThemeComponentDefaults({
    availableInRoles: [RoleName.NAMES.CoreUser, RoleName.NAMES.PlusUser, RoleName.NAMES.ProUser],
    name: 'Dark',
    identifier: NativeFeatureIdentifier.TYPES.DarkTheme,
    permission_name: PermissionName.FocusedTheme,
    clientControlled: true,
    isDark: true,
    dock_icon: {
      type: 'circle',
      background_color: '#a464c2',
      foreground_color: '#ffffff',
      border_color: '#a464c2',
    },
  })

  const titanium: ThemeFeatureDescription = FillThemeComponentDefaults({
    availableInRoles: [RoleName.NAMES.PlusUser, RoleName.NAMES.ProUser],
    name: 'Titanium',
    identifier: NativeFeatureIdentifier.TYPES.TitaniumTheme,
    permission_name: PermissionName.TitaniumTheme,
    dock_icon: {
      type: 'circle',
      background_color: '#6e2b9e',
      foreground_color: '#ffffff',
      border_color: '#6e2b9e',
    },
  })

  const dynamic: ThemeFeatureDescription = FillThemeComponentDefaults({
    availableInRoles: [RoleName.NAMES.PlusUser, RoleName.NAMES.ProUser],
    name: 'Dynamic Panels',
    identifier: NativeFeatureIdentifier.TYPES.DynamicTheme,
    permission_name: PermissionName.ThemeDynamic,
    layerable: true,
    no_mobile: true,
  })

  const proton: ThemeFeatureDescription = FillThemeComponentDefaults({
    availableInRoles: [RoleName.NAMES.CoreUser, RoleName.NAMES.PlusUser, RoleName.NAMES.ProUser],
    name: 'Carbon',
    identifier: NativeFeatureIdentifier.TYPES.ProtonTheme,
    permission_name: PermissionName.ProtonTheme,
    dock_icon: {
      type: 'circle',
      background_color: '#16141c',
      foreground_color: '#ffffff',
      border_color: '#4a4658',
    },
  })

  const allRoles = [RoleName.NAMES.CoreUser, RoleName.NAMES.PlusUser, RoleName.NAMES.ProUser]

  const dracula: ThemeFeatureDescription = FillThemeComponentDefaults({
    availableInRoles: allRoles,
    name: 'Dracula',
    identifier: NativeFeatureIdentifier.TYPES.DraculaTheme,
    permission_name: PermissionName.DraculaTheme,
    index_path: 'dist/dist.css',
    isDark: true,
    dock_icon: {
      type: 'circle',
      background_color: '#bd93f9',
      foreground_color: '#282a36',
      border_color: '#bd93f9',
    },
  })

  const standardBlueDark: ThemeFeatureDescription = FillThemeComponentDefaults({
    availableInRoles: allRoles,
    name: 'Standard Blue Dark',
    identifier: NativeFeatureIdentifier.TYPES.StandardBlueDarkTheme,
    permission_name: PermissionName.StandardBlueDarkTheme,
    index_path: 'dist/dist.css',
    isDark: true,
    dock_icon: {
      type: 'circle',
      background_color: '#086DD6',
      foreground_color: '#ffffff',
      border_color: '#086DD6',
    },
  })

  const darkMint: ThemeFeatureDescription = FillThemeComponentDefaults({
    availableInRoles: allRoles,
    name: 'Dark Mint',
    identifier: NativeFeatureIdentifier.TYPES.DarkMintTheme,
    permission_name: PermissionName.DarkMintTheme,
    index_path: 'dist/theme.css',
    isDark: true,
    dock_icon: {
      type: 'circle',
      background_color: '#3eb489',
      foreground_color: '#0d1f1a',
      border_color: '#3eb489',
    },
  })

  const lightsOut: ThemeFeatureDescription = FillThemeComponentDefaults({
    availableInRoles: allRoles,
    name: 'Lights Out',
    identifier: NativeFeatureIdentifier.TYPES.LightsOutTheme,
    permission_name: PermissionName.LightsOutTheme,
    index_path: 'dist/theme.css',
    isDark: true,
    dock_icon: {
      type: 'circle',
      background_color: '#0a0a0a',
      foreground_color: '#e0e0e0',
      border_color: '#3a3a3a',
    },
  })

  // The classic light Standard Notes look (white background, blue accent),
  // offered as a theme since the default base is now the dark "Standard Red".
  const standardNotesBlue: ThemeFeatureDescription = FillThemeComponentDefaults({
    availableInRoles: allRoles,
    name: 'Standard Notes Blue',
    identifier: NativeFeatureIdentifier.TYPES.StandardNotesBlueTheme,
    permission_name: PermissionName.StandardNotesBlueTheme,
    isDark: false,
    dock_icon: {
      type: 'circle',
      background_color: '#086DD6',
      foreground_color: '#ffffff',
      border_color: '#086DD6',
    },
  })

  return [
    standardNotesBlue,
    midnight,
    futura,
    solarizedDark,
    autobiography,
    dark,
    proton,
    titanium,
    dynamic,
    dracula,
    standardBlueDark,
    darkMint,
    lightsOut,
  ]
}
