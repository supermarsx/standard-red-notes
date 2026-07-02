import { promises as fs } from 'fs'

/**
 * Standard Red Notes: read-only view of the api-gateway's persisted runtime
 * server-settings overlay (the atomic JSON file the gateway's
 * PUT /v1/admin/server-settings writes — see the api-gateway package's
 * ServerSettingsStore).
 *
 * WHY IT LIVES HERE: the Nextcloud-backups master gate is ENFORCED auth-side
 * (TriggerNextcloudBackupForAllUsers), but the admin-set overlay is persisted
 * gateway-side. In the single-container image both services share a filesystem,
 * so the cleanest minimal bridge is reading the same file: the docker
 * entrypoint points both services' SERVER_SETTINGS_PATH at one path. When the
 * env var is unset (multi-service topologies without a shared volume, older
 * containers), every read returns `undefined` and the caller falls back to the
 * NEXTCLOUD_BACKUPS_ENABLED env exactly as before.
 *
 * PRECEDENCE (same contract as the gateway resolver): a persisted admin value
 * WINS over env; absence falls through to env, then the default (off).
 * Reads are lazy (per call, never cached) so an admin toggle takes effect on
 * the next scheduled run without a restart. Never throws — a missing/corrupt
 * file degrades to `undefined`.
 */
export class ServerSettingsOverlayReader {
  constructor(private readonly filePath: string | undefined) {}

  async nextcloudBackupsEnabled(): Promise<boolean | undefined> {
    const overlay = await this.read()
    const enabled = (overlay?.nextcloudBackups as { enabled?: unknown } | undefined)?.enabled

    return typeof enabled === 'boolean' ? enabled : undefined
  }

  private async read(): Promise<Record<string, unknown> | undefined> {
    if (!this.filePath) {
      return undefined
    }
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as unknown

      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined
    } catch {
      return undefined
    }
  }
}
