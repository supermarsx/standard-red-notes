/**
 * The checks that DO something, bound to the application.
 *
 * Everything worth testing about them lives elsewhere and is pure: what a
 * result means is `diagnosticChecks.ts`, and the file round trip's order,
 * clean-up and comparison are `diagnosticFileTransfer.ts`, which is handed a
 * port. This file is only the port — the smallest possible adapter from that
 * narrow contract onto the app's own clients — so that the part which cannot be
 * unit-tested without a server contains no decision.
 *
 * Nothing here returns text. A failure is `undefined` or `false`; the stage it
 * happened at is the message, and it is chosen by the caller.
 */
import { ContentType, isErrorResponse, SettingName, UuidGenerator, type ValetTokenOperation } from '@standardnotes/snjs'

import type { WebApplication } from '@/Application/WebApplication'

import type { FileTransferOperation, FileTransferPort } from './diagnosticFileTransfer'
import type { SyncRoundCounts } from './diagnosticChecks'

/**
 * The check's three operations, as the server names them.
 *
 * The enum is used as a TYPE and never as a value. Its members are these same
 * strings, which the `satisfies` proves at compile time — and reading
 * `ValetTokenOperation.Write` at module load would make this file, and with it
 * the whole diagnostics tab, depend on a runtime export being present in whatever
 * build of the library the page happens to be running.
 */
const valetOperation = (operation: FileTransferOperation): ValetTokenOperation =>
  operation satisfies `${ValetTokenOperation}` as ValetTokenOperation

/** The whole object goes to the account's own files, never a shared vault's. */
const OWNERSHIP = 'user' as const

const concatenate = (parts: readonly Uint8Array[]): Uint8Array => {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.byteLength
  }
  return joined
}

export function fileTransferPortFor(application: WebApplication, signal?: AbortSignal): FileTransferPort {
  const api = application.legacyApi
  const ensureActive = () => signal?.throwIfAborted()

  return {
    newIdentifier: () => UuidGenerator.GenerateUuid(),
    randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),

    authorize: async (remoteIdentifier, operation, bytes) => {
      if (operation !== 'delete') {
        ensureActive()
      }
      const token = await api.createUserFileValetToken(remoteIdentifier, valetOperation(operation), bytes)

      return typeof token === 'string' && token.length > 0 ? token : undefined
    },

    open: async (token) => {
      ensureActive()
      const response = await api.startUploadSession(token, OWNERSHIP)

      return !isErrorResponse(response) && Boolean(response.data?.uploadId)
    },

    send: (token, chunkId, bytes) => {
      ensureActive()
      return api.uploadFileBytes(token, OWNERSHIP, chunkId, bytes)
    },

    close: async (token) => {
      ensureActive()
      return (await api.closeUploadSession(token, OWNERSHIP)) === true
    },

    readOverHttp: async (token, object) => {
      ensureActive()
      const parts: Uint8Array[] = []
      // `downloadFile` issues ONE ranged request per declared chunk, so two
      // chunks is two `Range:` requests — which is the part of a download a
      // proxy that buffers or strips ranges breaks, and a whole-body GET hides.
      const failure = await api.downloadFile({
        file: {
          uuid: object.fileUuid,
          remoteIdentifier: object.remoteIdentifier,
          encryptedChunkSizes: [...object.chunkSizes],
          shared_vault_uuid: undefined,
        },
        chunkIndex: 0,
        valetToken: token,
        ownershipType: OWNERSHIP,
        abortSignal: signal,
        contentRangeStart: 0,
        onBytesReceived: async (bytes) => {
          ensureActive()
          // Copied: the caller may reuse the buffer it hands over.
          parts.push(bytes.slice())
        },
      })

      return failure === undefined ? concatenate(parts) : undefined
    },

    socketLaneNegotiated: () => application.syncTransportFileLane?.isFileLaneAvailable() === true,

    readOverSocket: async (object) => {
      ensureActive()
      const lane = application.syncTransportFileLane
      if (lane === undefined) {
        return 'unavailable'
      }

      const parts: Uint8Array[] = []
      const outcome = await lane.downloadFileOverSocket({
        remoteIdentifier: object.remoteIdentifier,
        fileUuid: object.fileUuid,
        declaredSize: object.bytes,
        signal,
        onBytes: async (bytes) => {
          ensureActive()
          parts.push(bytes.slice())
        },
      })
      if (outcome.outcome === 'unavailable') {
        return 'unavailable'
      }

      return outcome.outcome === 'completed' ? concatenate(parts) : undefined
    },

    remove: async (token) => !isErrorResponse(await api.deleteFile(token, OWNERSHIP)),

    usedBytes: async () => {
      if (signal?.aborted) {
        return undefined
      }
      const name = SettingName.create(SettingName.NAMES.FileUploadBytesUsed).getValue()
      const detail = await application.settings.getSubscriptionSettingDetail(name)
      // No row until a first upload succeeds: that is a measured zero, and it is
      // the value the counter must come back to.
      if (detail.value === undefined || detail.value === null) {
        return 0
      }
      const parsed = typeof detail.value === 'string' ? Number.parseFloat(detail.value) : Number.NaN

      return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
    },

    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
}

/**
 * How long a sync round is given to settle after `sync()` returns. `sync()` can
 * return before the round it asked for has finished — it is merged into one
 * already in flight — and a round that is going to FAIL takes its time about
 * it: it waits out an acknowledgement before it gives up. Five seconds missed
 * exactly those. Well inside the check's own deadline.
 */
const SYNC_SETTLE_MS = 25_000
const SYNC_POLL_MS = 100

const settled = (before: SyncRoundCounts, after: SyncRoundCounts): boolean =>
  after.socket !== before.socket || after.http !== before.http || after.failed !== before.failed

/**
 * Run one ordinary sync and report the transport's own counters either side of it.
 *
 * `undefined` on both sides when this build has no realtime transport to count
 * with — which the describer reports as unobservable rather than as a failure.
 */
export async function runSyncRound(application: WebApplication): Promise<{
  before: SyncRoundCounts | undefined
  after: SyncRoundCounts | undefined
  lastCarrier?: 'socket' | 'http' | 'failed'
}> {
  const read = (): SyncRoundCounts | undefined => application.syncTransportLedger?.syncRoundCounts
  const before = read()

  await application.sync.sync({ sourceDescription: 'admin diagnostics: sync round trip' })

  let after = read()
  for (let waited = 0; waited < SYNC_SETTLE_MS; waited += SYNC_POLL_MS) {
    if (before === undefined || after === undefined || settled(before, after)) {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, SYNC_POLL_MS))
    after = read()
  }

  const lastCarrier = application.syncTransportLedger?.lastSyncRound?.carrier

  return { before, after, ...(lastCarrier === undefined ? {} : { lastCarrier }) }
}

/**
 * Ask for the revision list of one note already in this account.
 *
 * Plain HTTP, for the reason the storage-usage read gives: `/v1/items` is a
 * forbidden family on the socket's control-plane lane by design.
 */
export async function readRevisionsOfOneNote(application: WebApplication): Promise<{ status: number } | 'no-note'> {
  const note = application.items.getItems(ContentType.TYPES.Note)[0]
  if (note === undefined) {
    return 'no-note'
  }

  const response = await application.httpOnlyJsonRequest<unknown>(
    'GET',
    `/v2/items/${encodeURIComponent(note.uuid)}/revisions`,
  )

  return { status: response.status }
}
