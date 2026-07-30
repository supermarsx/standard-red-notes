import { app } from 'electron'
import path from 'path'

/**
 * Filesystem-only paths used by the main-process services. Keep this module
 * free of webpack asset imports so the services can also run in Node tests.
 */
export const RuntimePaths = {
  get userDataDir(): string {
    return app.getPath('userData')
  },
  get homeDir(): string | undefined {
    try {
      return app.getPath('home')
    } catch {
      return undefined
    }
  },
  get documentsDir(): string | undefined {
    try {
      return app.getPath('documents')
    } catch {
      return undefined
    }
  },
  get tempDir(): string {
    return app.getPath('temp')
  },
  get extensionsDirRelative(): string {
    return 'Extensions'
  },
  get extensionsDir(): string {
    return path.join(RuntimePaths.userDataDir, RuntimePaths.extensionsDirRelative)
  },
  get extensionsMappingJson(): string {
    return path.join(RuntimePaths.extensionsDir, 'mapping.json')
  },
  get windowPositionJson(): string {
    return path.join(RuntimePaths.userDataDir, 'window-position.json')
  },
  get components(): string {
    return `${app.getAppPath()}/dist/web/components/assets`
  },
}
