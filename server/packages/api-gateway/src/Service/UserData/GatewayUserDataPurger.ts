import { Response } from 'express'
import { DeletedAccountMarkers, deletedAccountMarkersDirectory } from '@standardnotes/domain-core'

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
 * TWO WAYS A DELETION REACHES IT, and one record that ties them together:
 *
 *   1. The two routes that delete an account purge as soon as auth has
 *      answered with a success, so a feed token dies with the account.
 *   2. A deletion that does not pass through the gateway (`srn-admin` on the
 *      command line, any path added later) is written down by auth's own
 *      deletion handler as a MARKER (see DeletedAccountMarkers in domain-core),
 *      and the gateway works through the markers at start and on a timer.
 *
 * The gateway writes the same marker itself BEFORE it starts purging, and
 * removes a marker only when every store succeeded. So a purge that fails
 * half-way, or a process that dies in the middle of one, is not a silent
 * leftover: the marker is still there, the next sweep tries again, each failed
 * attempt is logged with the names of the stores that failed, and the number
 * of deletions still waiting is reported to the administrator.
 *
 * Where that safety net is itself missing, the log says so in as many words: a
 * purge that failed AND could not be recorded is reported as one that will not
 * be retried, and a record that cannot be read is reported on every sweep and
 * shown to the administrator as "unknown", never as zero.
 *
 * Each store is purged on its own. One that fails does not stop the others: a
 * locked reminder file must not be the reason a password stays behind.
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

export interface GatewayUserDataSweepResult {
  /** Deletions that were waiting when the sweep began. */
  found: number
  /** Of those, the ones whose data is now fully removed. */
  completed: number
  /** Of those, the ones that still have a store that could not be purged. */
  stillPending: number
}

/** Lower case, canonical 8-4-4-4-12: the only thing that is ever a user id here. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export class GatewayUserDataPurger {
  private sweeping: Promise<GatewayUserDataSweepResult> | undefined

  constructor(
    private readonly stores: readonly GatewayUserDataStore[],
    private readonly logger?: GatewayUserDataPurgerLogger,
    private readonly markers: DeletedAccountMarkers = new DeletedAccountMarkers(undefined),
  ) {}

  /** One attempt at every store. Leaves the markers alone. */
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

  /**
   * Purges a user whose account HAS been deleted, and keeps a record until it
   * is done. The record is written first: if the process stops between here
   * and the last store, the next sweep still knows.
   */
  async purgeDeletedAccount(userUuid: string): Promise<GatewayUserDataPurgeResult> {
    const recorded = await this.markers.add(userUuid)
    const result = await this.purge(userUuid)
    if (result.failed === 0) {
      await this.markers.remove(userUuid)
    } else if (!recorded && this.logger !== undefined) {
      // The one case nothing will pick up again. An operator queues it by
      // hand: an empty file named by the user id, in the record directory.
      this.logger.warn('gateway user data purge will NOT be retried: the deletion could not be recorded', {
        userId: typeof userUuid === 'string' ? userUuid.toLowerCase() : '',
      })
    }
    return result
  }

  /**
   * How many deleted accounts still have gateway data waiting to be removed,
   * or `null` when the record cannot be read and the number is unknown.
   */
  async pendingCount(): Promise<number | null> {
    const waiting = await this.markers.read()
    return waiting === undefined ? null : waiting.length
  }

  /**
   * Works through every recorded deletion: the ones auth wrote down for a
   * deletion that never passed through the gateway, and the ones a failed or
   * interrupted purge left behind. Never throws. One sweep runs at a time; a
   * call made while one is running gets that run's result.
   */
  async sweep(): Promise<GatewayUserDataSweepResult> {
    if (this.sweeping === undefined) {
      this.sweeping = this.sweepOnce().finally(() => {
        this.sweeping = undefined
      })
    }
    return this.sweeping
  }

  /**
   * Sweeps shortly after start and then on an interval. The timers never keep
   * the process alive. Returns a function that stops them.
   */
  startSweeping(intervalMs: number, initialDelayMs: number): () => void {
    if (!this.markers.isConfigured() || !(intervalMs > 0)) {
      return () => undefined
    }
    const run = (): void => {
      void this.sweep()
    }
    const first = setTimeout(run, Math.max(0, initialDelayMs))
    const repeat = setInterval(run, intervalMs)
    first.unref()
    repeat.unref()
    return () => {
      clearTimeout(first)
      clearInterval(repeat)
    }
  }

  private async sweepOnce(): Promise<GatewayUserDataSweepResult> {
    const summary: GatewayUserDataSweepResult = { found: 0, completed: 0, stillPending: 0 }
    let waiting: string[] | undefined
    try {
      waiting = await this.markers.read()
    } catch {
      waiting = undefined
    }
    if (waiting === undefined) {
      if (this.logger !== undefined) {
        this.logger.warn(
          'the record of deleted accounts cannot be read: gateway user data of deleted accounts is not being removed',
        )
      }
      return summary
    }
    summary.found = waiting.length

    for (const userUuid of waiting) {
      try {
        const result = await this.purge(userUuid)
        if (result.failed === 0 && (await this.markers.remove(userUuid))) {
          summary.completed += 1
        } else {
          summary.stillPending += 1
        }
      } catch {
        summary.stillPending += 1
      }
    }

    if (this.logger !== undefined && summary.stillPending > 0) {
      // Said on every sweep while it is true, so that it cannot scroll away.
      this.logger.warn('gateway user data of deleted accounts is still waiting to be removed', {
        waiting: summary.stillPending,
        completed: summary.completed,
      })
    }
    return summary
  }
}

/**
 * How long after start the first sweep runs, and how often after that. The
 * interval is how long a deleted account's feed token can outlive a deletion
 * that did not pass through the gateway; a sweep with nothing recorded is one
 * directory listing, so it is kept short.
 */
export const GATEWAY_USER_DATA_FIRST_SWEEP_AFTER_MS = 30 * 1000
export const GATEWAY_USER_DATA_SWEEP_EVERY_MS = 60 * 1000

/**
 * The purger a running gateway uses: its record of deleted accounts sits beside
 * the shared settings file, where auth writes the same record, and it is
 * already sweeping when this returns. The container calls this and nothing
 * else, so "has a purger" and "the purger is sweeping" cannot come apart.
 */
export function startGatewayUserDataPurger(options: {
  stores: readonly GatewayUserDataStore[]
  logger?: GatewayUserDataPurgerLogger
  serverSettingsPath: string | undefined
}): GatewayUserDataPurger {
  const purger = new GatewayUserDataPurger(
    options.stores,
    options.logger,
    new DeletedAccountMarkers(deletedAccountMarkersDirectory(options.serverSettingsPath)),
  )
  purger.startSweeping(GATEWAY_USER_DATA_SWEEP_EVERY_MS, GATEWAY_USER_DATA_FIRST_SWEEP_AFTER_MS)
  return purger
}

/**
 * Called by the two routes that delete an account, after the auth service has
 * answered. It purges only when that answer went out as a success: a refused
 * deletion (wrong password, not the owner, the last administrator) must leave
 * everything exactly as it was.
 *
 * It never throws and never writes to the response, which has already been
 * sent. A purge that could not finish stays recorded and is retried by the
 * sweep; see the class comment.
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
    await purger.purgeDeletedAccount(userUuid)
  } catch {
    // The purger reports its own failures. Nothing here may surface as an
    // unhandled rejection in a route whose answer has already gone out.
  }
}
