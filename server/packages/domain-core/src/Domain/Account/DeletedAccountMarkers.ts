import { promises as fs } from 'fs'
import * as path from 'path'

/**
 * Standard Red Notes: a durable note that an account was deleted, for services
 * that keep data about users outside the database.
 *
 * WHY THIS EXISTS. Account deletion is carried by an event that the services
 * with a queue consume. The api-gateway has no queue and no database: it keeps
 * a few per-user stores in JSON files (connected CalDAV accounts with their
 * encrypted passwords, CalDAV feed tokens, published calendar items, reminder
 * destinations). Nothing told it when an account went away, so that data
 * outlived the account and a feed token issued to a deleted account kept
 * working.
 *
 * The gateway now purges when a deletion passes through it. That alone covers
 * neither a deletion that does not pass through it (the `srn-admin` command
 * line, any path added later) nor a purge that failed half-way. So the fact of
 * a deletion is also written down, here, by the one handler every deletion
 * reaches, and by the gateway itself before it starts purging. The gateway
 * works through these notes at start and on a timer, and removes a note only
 * when every store has been purged for that user.
 *
 * FORM. One empty file per deleted account, named by the account's id, in
 * `deleted-accounts` beside the shared server settings file. That directory is
 * the one place every process of a deployment already agrees on (each is
 * pointed at the same SERVER_SETTINGS_PATH). An empty file needs no parsing, no
 * lock and no format version, and creating one is atomic.
 *
 * A marker says "purge this id". It is therefore written only AFTER a deletion
 * has been decided, and only a string with the exact shape of an account id is
 * ever read back as one.
 */

export const DELETED_ACCOUNT_MARKERS_DIRECTORY_NAME = 'deleted-accounts'

/** Lower case, canonical 8-4-4-4-12. */
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Where the markers live for a deployment whose shared settings file is at
 * `serverSettingsPath`, or `undefined` when no shared location is configured.
 */
export function deletedAccountMarkersDirectory(serverSettingsPath: string | undefined | null): string | undefined {
  const settingsPath = typeof serverSettingsPath === 'string' ? serverSettingsPath.trim() : ''
  if (settingsPath.length === 0) {
    return undefined
  }
  return path.join(path.dirname(path.resolve(settingsPath)), DELETED_ACCOUNT_MARKERS_DIRECTORY_NAME)
}

export class DeletedAccountMarkers {
  constructor(private readonly directory: string | undefined) {}

  /** False when no shared location is configured; then nothing is recorded or listed. */
  isConfigured(): boolean {
    return this.directory !== undefined
  }

  /**
   * Records that an account was deleted. Returns whether a marker now exists.
   * Never throws: failing to write a note must not fail the deletion it is
   * about.
   */
  async add(accountId: string): Promise<boolean> {
    const file = this.fileFor(accountId)
    if (file === undefined || this.directory === undefined) {
      return false
    }
    try {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
      const handle = await fs.open(file, 'a', 0o600)
      await handle.close()
      return true
    } catch {
      return false
    }
  }

  /** Removes a marker. Returns whether it is gone (also true when it was never there). */
  async remove(accountId: string): Promise<boolean> {
    const file = this.fileFor(accountId)
    if (file === undefined) {
      return false
    }
    try {
      await fs.unlink(file)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
    }
  }

  /**
   * The ids with a marker, sorted, or `undefined` when the record exists but
   * cannot be read (wrong owner, not a directory, a failing disk). "Nothing
   * recorded" and "cannot tell" are different answers: a caller that treats
   * the second as the first stops purging without anyone noticing.
   *
   * Anything in the directory that is not an account id is ignored.
   */
  async read(): Promise<string[] | undefined> {
    if (this.directory === undefined) {
      return []
    }
    let entries: Array<{ name: string; isFile(): boolean }>
    try {
      entries = await fs.readdir(this.directory, { withFileTypes: true })
    } catch (error) {
      // No directory yet means no deletion has been recorded yet.
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : undefined
    }
    return entries
      .filter((entry) => entry.isFile() && ACCOUNT_ID_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort()
  }

  /** As `read`, for a caller that has nothing to do with the difference: unreadable lists as empty. */
  async list(): Promise<string[]> {
    return (await this.read()) ?? []
  }

  private fileFor(accountId: string): string | undefined {
    const normalized = typeof accountId === 'string' ? accountId.toLowerCase() : ''
    // The id becomes a file name, so only one exact shape is ever one.
    if (this.directory === undefined || !ACCOUNT_ID_PATTERN.test(normalized)) {
      return undefined
    }
    return path.join(this.directory, normalized)
  }
}
