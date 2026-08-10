const fs = require('fs')
const path = require('path')

const APPLE_CREDENTIALS = ['APPLE_TEAM_ID', 'NOTARIZE_APPLE_ID', 'NOTARIZE_APPLE_ID_PASSWORD']

function missingCredentials(env) {
  return APPLE_CREDENTIALS.filter((name) => !env[name])
}

module.exports = async function notarizeMac(params, dependencies = {}) {
  if (params.electronPlatformName !== 'darwin') {
    return
  }

  const env = dependencies.env || process.env
  const log = dependencies.log || console.log
  const missing = missingCredentials(env)
  if (missing.length > 0) {
    const message = `macOS release authenticity credentials missing: ${missing.join(', ')}`
    if (env.REQUIRE_DESKTOP_AUTHENTICITY === 'true') {
      throw new Error(message)
    }
    log(`Skipping macOS notarization for this non-publishing build: ${message}`)
    return
  }

  const promises = dependencies.fsPromises || fs.promises
  const electronNotarize = dependencies.electronNotarize || require('@electron/notarize')
  const { appId } = JSON.parse(await promises.readFile('./package.json')).build
  const appPath = path.join(params.appOutDir, `${params.packager.appInfo.productFilename}.app`)

  await promises.access(appPath)
  log(`Notarizing ${appId} at ${appPath}`)
  await electronNotarize.notarize({
    teamId: env.APPLE_TEAM_ID,
    appBundleId: appId,
    appPath,
    appleId: env.NOTARIZE_APPLE_ID,
    appleIdPassword: env.NOTARIZE_APPLE_ID_PASSWORD,
  })
  await electronNotarize.staple({ appPath })
  log(`Notarized and stapled ${appId}`)
}
