import { KeyParamsData } from '@standardnotes/responses'
import { MapperInterface } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { Item } from '../../Domain/Item/Item'
import {
  WebDAVBackupDestination,
  WebDAVItemBackupServiceInterface,
} from '../../Domain/Item/WebDAVItemBackupServiceInterface'
import { ItemHttpRepresentation } from '../../Mapping/Http/ItemHttpRepresentation'
import { WebDAVClientInterface } from './WebDAVClientInterface'

/**
 * Standard Red Notes: uploads the user's ALREADY end-to-end encrypted items to a
 * Nextcloud instance over WebDAV. Mirrors S3ItemBackupService's payload shape
 * (items + auth_params) but writes to a per-user Nextcloud destination via an
 * injected WebDAVClientInterface (mockable for tests).
 *
 * HONESTY / WHAT IS EXPOSED:
 *  - PROTECTED: note content -- the items written are the same ciphertext the server
 *    already holds. Nextcloud cannot read them without the user's account password.
 *  - EXPOSED: the app password (stored server-side to authenticate the upload), and
 *    upload metadata (timing + file size) are visible to whoever controls the server
 *    and/or the Nextcloud instance.
 */
export class WebDAVItemBackupService implements WebDAVItemBackupServiceInterface {
  constructor(
    private httpMapper: MapperInterface<Item, ItemHttpRepresentation>,
    private webDAVClient: WebDAVClientInterface,
    private logger: Logger,
  ) {}

  async uploadBackup(
    items: Item[],
    authParams: KeyParamsData,
    destination: WebDAVBackupDestination,
  ): Promise<string | null> {
    const username = destination.username?.trim()
    if (!destination.url || !destination.appPassword || !username) {
      this.logger.warn('Nextcloud WebDAV backup not configured (missing url, app password, or username). Skipping.')

      return null
    }

    const itemProjections: ItemHttpRepresentation[] = items.map((item) => this.httpMapper.toProjection(item))

    const contents = JSON.stringify({
      items: itemProjections,
      auth_params: authParams,
    })

    const dateOnly = new Date().toISOString().substring(0, 10)
    const fileName = `SN-Data-${dateOnly}.json`

    try {
      await this.webDAVClient.putFile(
        {
          url: destination.url,
          username,
          appPassword: destination.appPassword,
          folder: destination.folder,
          fileName,
        },
        contents,
      )

      return fileName
    } catch (error) {
      // Errors are logged and swallowed so a single user's failed upload never
      // crashes the batch job. The app password is never logged.
      this.logger.error(`Could not upload Nextcloud WebDAV backup: ${(error as Error).message}`)

      return null
    }
  }
}
