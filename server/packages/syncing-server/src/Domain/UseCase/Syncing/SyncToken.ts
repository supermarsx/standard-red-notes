import * as crypto from 'crypto'
import { Time } from '@standardnotes/time'

/**
 * Standard Red Notes (t99): the sync token, read and written in one place.
 *
 * The token is a POSITION: "you have been shown every row at or below this
 * microsecond". Two independent defects came from nobody owning that sentence.
 *
 *  - The response token was taken from the SAVE half of a sync while the rows
 *    came from the GET half, so it claimed a position the response had never
 *    shown. Every row another device committed in between was skipped for good.
 *  - A vault-exclusive retrieval returned that same global position, so
 *    replaying it as a global token reported "fully caught up" for an account
 *    whose items had never been looked at.
 *
 * WIRE FORMAT. A token is `2:<seconds>` followed by zero or more `:<key>=<value>`
 * fields. The extension is deliberately BACKWARD COMPATIBLE: a reader that only
 * knows the original one-field v2 token takes `tokenParts[0]` and ignores the
 * rest, so an older syncing-server handed one of these tokens reads the position
 * and re-delivers — which is the conservative half of every choice here. Clients
 * never parse a sync token; it is opaque to them.
 *
 * Fields:
 *   s=<uuid>   the session whose own writes the next retrieval may skip
 *   w=<micros> the ceiling of that skip; above it nothing is ever skipped
 *   v=<hex>    the retrieval scope this position was measured in. Absent means
 *              the account's whole scope. A scoped position is NOT a global one
 *              and must never be honoured as one.
 */

export const SYNC_TOKEN_VERSION = 2

/**
 * How far ahead of this server's own clock a presented position may sit before
 * it is refused. A legitimate token is at most a microsecond or two ahead (the
 * `+1µs` double-prevention); this allowance exists only so that clock skew
 * between replicas cannot reject real tokens. A position a year out is not skew.
 */
export const SYNC_POSITION_FUTURE_ALLOWANCE_MICROSECONDS = 5 * 60 * Time.MicrosecondsInASecond

export type SyncTokenFields = {
  /** Rows at or below this microsecond have been delivered. */
  positionMicroseconds: number
  /**
   * The session whose writes up to `ownWriteCeilingMicroseconds` the next
   * retrieval may skip, because the response that issued this token already
   * handed them back as `savedItems`.
   */
  ownWriteSessionUuid?: string
  ownWriteCeilingMicroseconds?: number
  /** The retrieval scope digest; undefined for the account's whole scope. */
  scopeDigest?: string
}

/**
 * The digest of a retrieval scope. `undefined` for an unrestricted (whole
 * account) retrieval, so an ordinary token keeps its exact previous bytes.
 */
export const scopeDigestFor = (exclusiveSharedVaultUuids: string[] | undefined): string | undefined => {
  if (exclusiveSharedVaultUuids === undefined || exclusiveSharedVaultUuids.length === 0) {
    return undefined
  }

  return crypto
    .createHash('sha256')
    .update([...exclusiveSharedVaultUuids].sort().join(','))
    .digest('hex')
    .substring(0, 16)
}

export const encodeSyncToken = (fields: SyncTokenFields): string => {
  const parts = [`${SYNC_TOKEN_VERSION}`, `${fields.positionMicroseconds / Time.MicrosecondsInASecond}`]

  if (fields.ownWriteSessionUuid !== undefined && fields.ownWriteCeilingMicroseconds !== undefined) {
    parts.push(`s=${fields.ownWriteSessionUuid}`, `w=${fields.ownWriteCeilingMicroseconds}`)
  }
  if (fields.scopeDigest !== undefined) {
    parts.push(`v=${fields.scopeDigest}`)
  }

  return Buffer.from(parts.join(':'), 'utf-8').toString('base64')
}

/**
 * Read the extension fields off an already-split v2 token body (the parts after
 * the version and the seconds). Anything unrecognised, duplicated or malformed
 * is DROPPED rather than rejected: every field here can only ever cause the
 * server to deliver LESS, so losing one degrades to re-delivery, and that is the
 * safe direction.
 */
export const decodeSyncTokenExtension = (
  parts: string[],
): { ownWriteSessionUuid?: string; ownWriteCeilingMicroseconds?: number; scopeDigest?: string } => {
  let ownWriteSessionUuid: string | undefined = undefined
  let ownWriteCeilingMicroseconds: number | undefined = undefined
  let scopeDigest: string | undefined = undefined

  for (const part of parts) {
    const separator = part.indexOf('=')
    if (separator < 1) {
      continue
    }
    const key = part.substring(0, separator)
    const value = part.substring(separator + 1)

    if (key === 's' && /^[0-9a-fA-F-]{36}$/.test(value)) {
      ownWriteSessionUuid = value
    } else if (key === 'w') {
      const ceiling = Number(value)
      if (Number.isSafeInteger(ceiling) && ceiling >= 0) {
        ownWriteCeilingMicroseconds = ceiling
      }
    } else if (key === 'v' && /^[0-9a-f]{16}$/.test(value)) {
      scopeDigest = value
    }
  }

  // The two own-write fields are only meaningful together.
  if (ownWriteSessionUuid === undefined || ownWriteCeilingMicroseconds === undefined) {
    return { scopeDigest }
  }

  return { ownWriteSessionUuid, ownWriteCeilingMicroseconds, scopeDigest }
}

/** The microsecond position a v2 token encodes, or undefined if it is not one. */
export const decodeSyncTokenPosition = (token: string): number | undefined => {
  const parts = Buffer.from(token, 'base64').toString('utf-8').split(':')
  if (parts.shift() !== `${SYNC_TOKEN_VERSION}`) {
    return undefined
  }

  const seconds = Number(parts[0])
  const microseconds = Math.round(seconds * Time.MicrosecondsInASecond)

  return Number.isFinite(seconds) && Number.isSafeInteger(microseconds) && microseconds >= 0 ? microseconds : undefined
}
