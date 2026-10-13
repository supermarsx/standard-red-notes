import { Response } from 'express'

/**
 * Standard Red Notes: what the api-gateway holds about a user, and removes
 * when that user's account is deleted.
 *
 * The gateway has no database. It keeps a handful of per-user stores in JSON
 * files of its own: connected DAV accounts (an encrypted external password),
 * CalDAV access tokens, published calendar items and their projection
 * settings, reminder-delivery destinations. Account deletion happens in the
 * auth service, which knows nothing about those files, and nothing here
 * listened for it. So they outlived the account: a deleted user's Nextcloud
 * password stayed on disk, and their CalDAV token kept working.
 *
 * This is the one place that knows every such store. A store added to the
 * gateway later is added HERE, and the test for this class fails when a user's
 * id can still be found in the gateway's data directory after a purge.
 *
 * Each store is purged on its own. One that fails is reported and does not
 * stop the others: a locked reminder file must not be the reason a password
 * stays behind.
 */

export interface GatewayUserDataStore {
  /** A fixed name for the log line. Not user data. */
  readonly name: string
  /** Removes everything held for the user and returns how many records that was. */
  purge(userUuid: string): Promise<number>
}

export interface GatewayUserDataPurgerLogger {
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
}

export interface GatewayUserDataPurgeResult {
  /** store name -> records removed, or 'failed' */
  stores: Record<string, number | 'failed'>
  removed: number
  failed: number
}

/** Lower case, canonical 8-4-4-4-12: the only thing that is ever a user id here. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export class GatewayUserDataPurger {
  constructor(
    private readonly stores: readonly GatewayUserDataStore[],
    private readonly logger?: GatewayUserDataPurgerLogger,
  ) {}

  async purge(userUuid: string): Promise<GatewayUserDataPurgeResult> {
    const result: GatewayUserDataPurgeResult = { stores: {}, removed: 0, failed: 0 }
    const normalized = typeof userUuid === 'string' ? userUuid.toLowerCase() : ''
    if (!UUID_PATTERN.test(normalized)) {
      return result
    }

    for (const store of this.stores) {
      try {
        const removed = await store.purge(normalized)
        result.stores[store.name] = removed
        result.removed += removed
      } catch {
        // The failure's own text can name a file by user, so only the fact of
        // it is kept.
        result.stores[store.name] = 'failed'
        result.failed += 1
      }
    }

    if (this.logger !== undefined) {
      if (result.failed > 0) {
        this.logger.warn('gateway user data purge incomplete after account deletion', {
          userId: normalized,
          removed: result.removed,
          failedStores: Object.entries(result.stores)
            .filter(([, outcome]) => outcome === 'failed')
            .map(([name]) => name),
        })
      } else if (result.removed > 0) {
        this.logger.info('gateway user data purged after account deletion', {
          userId: normalized,
          removed: result.removed,
        })
      }
    }

    return result
  }
}

/**
 * Called by the two routes that delete an account, after the auth service has
 * answered. It purges only when that answer went out as a success: a refused
 * deletion (wrong password, not the owner, the last administrator) must leave
 * everything exactly as it was.
 *
 * It never throws and never writes to the response, which has already been
 * sent. A purge that fails is logged by the purger; the account is deleted
 * either way, and an administrator can purge what is left.
 */
export async function purgeGatewayUserDataAfterDeletion(
  purger: GatewayUserDataPurger | undefined,
  response: Pick<Response, 'statusCode' | 'headersSent'>,
  userUuid: unknown,
): Promise<void> {
  if (purger === undefined || typeof userUuid !== 'string') {
    return
  }
  // `statusCode` is 200 on a response nothing has been written to, so the
  // status alone would read an unanswered request as a success.
  if (!response.headersSent || response.statusCode < 200 || response.statusCode >= 300) {
    return
  }
  try {
    await purger.purge(userUuid)
  } catch {
    // The purger reports its own failures. Nothing here may surface as an
    // unhandled rejection in a route whose answer has already gone out.
  }
}
