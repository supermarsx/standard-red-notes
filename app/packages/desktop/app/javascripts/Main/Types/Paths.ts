import decryptScript from 'decrypt/dist/decrypt.html'
import path from 'path'
import grantLinuxPasswordsAccess from '../../../grantLinuxPasswordsAccess.html'
import index from '../../../index.html'
import { RuntimePaths } from './RuntimePaths'

function url(fileName: string): string {
  if ('APP_RELATIVE_PATH' in process.env) {
    return 'file://' + path.resolve(__dirname, process.env.APP_RELATIVE_PATH as string, fileName)
  }
  return 'file://' + path.resolve(__dirname, fileName)
}

function filePath(fileName: string): string {
  if ('APP_RELATIVE_PATH' in process.env) {
    return path.join(__dirname, process.env.APP_RELATIVE_PATH as string, fileName)
  }
  return path.join(__dirname, fileName)
}

export const Urls = {
  get indexHtml(): string {
    return url(index)
  },
  get grantLinuxPasswordsAccessHtml(): string {
    return url(grantLinuxPasswordsAccess)
  },
}

/**
 * App paths can be modified at runtime, most frequently at startup, so don't
 * store the results of these getters in long-lived constants (like static class
 * fields).
 */
export const Paths = {
  get userDataDir(): string {
    return RuntimePaths.userDataDir
  },
  get homeDir(): string | undefined {
    return RuntimePaths.homeDir
  },
  get documentsDir(): string | undefined {
    return RuntimePaths.documentsDir
  },
  get tempDir(): string {
    return RuntimePaths.tempDir
  },
  get extensionsDirRelative(): string {
    return RuntimePaths.extensionsDirRelative
  },
  get extensionsDir(): string {
    return RuntimePaths.extensionsDir
  },
  get extensionsMappingJson(): string {
    return RuntimePaths.extensionsMappingJson
  },
  get windowPositionJson(): string {
    return RuntimePaths.windowPositionJson
  },
  get decryptScript(): string {
    return filePath(decryptScript)
  },
  get preloadJs(): string {
    return path.join(__dirname, 'javascripts/renderer/preload.js')
  },
  get components(): string {
    return RuntimePaths.components
  },
  get grantLinuxPasswordsAccessJs(): string {
    return path.join(__dirname, 'javascripts/renderer/grantLinuxPasswordsAccess.js')
  },
}
