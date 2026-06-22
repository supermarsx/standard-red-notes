// Electron Forge config for the Standard Red Notes desktop app.
//
// Forge runs from this inner runtime package (app/packages/desktop/app), which
// after the outer webpack build contains the compiled `dist/`, the copied web
// bundle (dist/web), runtime native deps (keytar, @standardnotes/home-server)
// in node_modules, and the window assets. The outer package builds those; Forge
// only packages + makes installers from this directory.
//
// Migrated from electron-builder. Translation notes:
//   appId            -> packagerConfig.appBundleId
//   protocols        -> packagerConfig.protocols
//   mac entitlements -> packagerConfig.osxSign (only when signing creds present)
//   win nsis         -> maker-squirrel (also what update.electronjs.org needs)
//   mac dmg+zip      -> maker-dmg + maker-zip
//   linux deb+rpm    -> maker-deb + maker-rpm
//   linux AppImage   -> @reforged/maker-appimage (no first-party Forge maker)
//   linux snap       -> built separately via snapcraft in CI (Forge has no maker)
const { FusesPlugin } = require('@electron-forge/plugin-fuses')
const { FuseV1Options, FuseVersion } = require('@electron/fuses')

const LINUX_ICON = './icon/Icon-512x512.png'
const MAINTAINER = 'Standard Red Notes'
const HOMEPAGE = 'https://github.com/supermarsx/standard-red-notes'

// macOS signing/notarization is opt-in: only wire it up when the CI secrets are
// present. Without them the build is produced UNSIGNED (no error), which is the
// default for the public self-hosted release.
const macSigningEnabled = Boolean(process.env.APPLE_TEAM_ID && process.env.APPLE_ID)

module.exports = {
  packagerConfig: {
    name: 'Standard Red Notes',
    executableName: process.platform === 'linux' ? 'standard-red-notes' : 'Standard Red Notes',
    appBundleId: 'org.standardrednotes.app',
    appCategoryType: 'public.app-category.productivity',
    // Resolves ../build/icon.ico (win) and ../build/icon.icns (mac) at build time.
    icon: '../build/icon',
    asar: true,
    protocols: [{ name: 'Standard Red Notes', schemes: ['standardrednotes'] }],
    extendInfo: {
      NSCameraUsageDescription:
        'Standard Red Notes requires access to your camera to enable the Moments feature.',
    },
    // Keep the packaged app lean: this inner dir also holds the TypeScript
    // sources (compiled into dist/ by the outer webpack build) and dev cruft.
    ignore: [/\.map$/, /\.ts$/, /^\/@types($|\/)/, /^\/test($|\/)/, /^\/tsconfig.*\.json$/],
    osxSign: macSigningEnabled
      ? {
          optionsForFile: () => ({
            hardenedRuntime: true,
            entitlements: '../build/entitlements.mac.inherit.plist',
            'entitlements-inherit': '../build/entitlements.mac.inherit.plist',
          }),
        }
      : undefined,
    osxNotarize: macSigningEnabled
      ? {
          appleId: process.env.APPLE_ID,
          appleIdPassword: process.env.APPLE_ID_PASSWORD,
          teamId: process.env.APPLE_TEAM_ID,
        }
      : undefined,
  },

  // Forge rebuilds keytar + @standardnotes/home-server against the Electron ABI.
  rebuildConfig: {},

  makers: [
    // Windows: Squirrel installer (.exe) — this is the format update.electronjs.org
    // serves auto-updates for. Squirrel runs on win32; primary target is x64.
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'standard_red_notes',
        setupIcon: '../build/icon.ico',
        iconUrl: 'https://raw.githubusercontent.com/supermarsx/standard-red-notes/main/app/packages/desktop/build/icon.ico',
      },
    },
    // Portable zip for macOS (required by the Squirrel.Mac auto-updater) and as a
    // no-installer fallback on Windows (covers win-arm64 where Squirrel is weak).
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'win32'],
    },
    // macOS disk image.
    {
      name: '@electron-forge/maker-dmg',
      config: { icon: '../build/icon.icns' },
    },
    // Debian/Ubuntu package.
    {
      name: '@electron-forge/maker-deb',
      config: {
        options: {
          name: 'standard-red-notes',
          productName: 'Standard Red Notes',
          maintainer: MAINTAINER,
          homepage: HOMEPAGE,
          categories: ['Office'],
          icon: LINUX_ICON,
        },
      },
    },
    // Fedora/RHEL package.
    {
      name: '@electron-forge/maker-rpm',
      config: {
        options: {
          name: 'standard-red-notes',
          productName: 'Standard Red Notes',
          homepage: HOMEPAGE,
          categories: ['Office'],
          icon: LINUX_ICON,
        },
      },
    },
    // Portable single-file AppImage (community maker; no first-party Forge one).
    {
      name: '@reforged/maker-appimage',
      config: {
        options: {
          name: 'standard-red-notes',
          productName: 'Standard Red Notes',
          categories: ['Office'],
          icon: LINUX_ICON,
        },
      },
    },
  ],

  plugins: [
    // Unpack native .node modules (keytar, home-server) out of the asar so they
    // load at runtime — replaces electron-builder's asarUnpack.
    { name: '@electron-forge/plugin-auto-unpack-natives', config: {} },
    // Harden the runtime: disable Node CLI/inspection fuses, enforce asar
    // integrity and cookie encryption.
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],

  publishers: [
    {
      name: '@electron-forge/publisher-github',
      config: {
        repository: { owner: 'supermarsx', name: 'standard-red-notes' },
        prerelease: false,
        draft: true,
      },
    },
  ],
}
