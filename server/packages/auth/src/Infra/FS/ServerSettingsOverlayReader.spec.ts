import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'

import { ServerSettingsOverlayReader } from './ServerSettingsOverlayReader'

describe('ServerSettingsOverlayReader (signup limits + logging level)', () => {
  let filePath: string

  const writeOverlay = async (contents: unknown): Promise<void> => {
    await fs.writeFile(filePath, JSON.stringify(contents), 'utf8')
  }

  beforeEach(async () => {
    filePath = path.join(os.tmpdir(), `srn-overlay-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  })

  afterEach(async () => {
    try {
      await fs.unlink(filePath)
    } catch {
      // best-effort cleanup
    }
  })

  describe('signupLimits()', () => {
    it('reads only the numeric signup-cap fields an admin has persisted', async () => {
      await writeOverlay({
        registration: {
          defaultRole: 'CORE_USER',
          signupsPerIpMax: 5,
          signupsPerIpWindowHours: 12,
          signupsPerWeekMax: 100,
          signupsPerDeviceMax: 2,
          signupsPerDeviceWindowHours: 6,
        },
      })

      const reader = new ServerSettingsOverlayReader(filePath)

      expect(await reader.signupLimits()).toEqual({
        perIpMax: 5,
        perIpWindowHours: 12,
        perWeekMax: 100,
        perDeviceMax: 2,
        perDeviceWindowHours: 6,
      })
    })

    it('ignores non-numeric values and returns only the present fields', async () => {
      await writeOverlay({
        registration: { signupsPerIpMax: 5, signupsPerWeekMax: 'lots', signupsPerDeviceMax: null },
      })

      const reader = new ServerSettingsOverlayReader(filePath)

      expect(await reader.signupLimits()).toEqual({ perIpMax: 5 })
    })

    it('returns undefined when no signup-cap fields are present', async () => {
      await writeOverlay({ registration: { defaultRole: 'CORE_USER' } })

      const reader = new ServerSettingsOverlayReader(filePath)

      expect(await reader.signupLimits()).toBeUndefined()
    })

    it('returns undefined (never throws) when the file is missing/unset', async () => {
      expect(await new ServerSettingsOverlayReader(undefined).signupLimits()).toBeUndefined()
      expect(await new ServerSettingsOverlayReader('/no/such/file.json').signupLimits()).toBeUndefined()
    })
  })

  describe('loggingLevel()', () => {
    it('reads a valid persisted level', async () => {
      await writeOverlay({ logging: { level: 'debug' } })

      expect(await new ServerSettingsOverlayReader(filePath).loggingLevel()).toBe('debug')
    })

    it('normalizes case/whitespace', async () => {
      await writeOverlay({ logging: { level: '  WARN ' } })

      expect(await new ServerSettingsOverlayReader(filePath).loggingLevel()).toBe('warn')
    })

    it('returns undefined for an unknown level', async () => {
      await writeOverlay({ logging: { level: 'chatty' } })

      expect(await new ServerSettingsOverlayReader(filePath).loggingLevel()).toBeUndefined()
    })

    it('returns undefined when logging is absent or the file is unreadable', async () => {
      await writeOverlay({ registration: {} })
      expect(await new ServerSettingsOverlayReader(filePath).loggingLevel()).toBeUndefined()
      expect(await new ServerSettingsOverlayReader(undefined).loggingLevel()).toBeUndefined()
    })
  })
})
