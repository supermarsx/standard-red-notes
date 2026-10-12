/**
 * The file-transfer round trip: the one check in this pane that WRITES.
 *
 * *** WHY IT EXISTS. *** Every other reading of the files path is a necessary
 * condition and none of them is a transfer: the readiness probe carries no
 * credential, the boot gate reports a composition decision, and a presence
 * boolean says a variable is non-empty and not that two services agree about
 * its contents. A deployment once showed all of them green while downloads hung
 * forever. The only thing that establishes a file can be stored and read back is
 * storing one and reading it back.
 *
 * *** WHAT IT MAY AND MAY NOT TOUCH. ***
 *
 *   - It stores ONE object of `FILE_TRANSFER_BYTES` random bytes under an
 *     identifier it makes up, and deletes that object before it returns.
 *   - It creates NO file item. The object is never referenced by anything in the
 *     account, so nothing appears in the operator's files and nothing syncs.
 *   - It reads, changes and deletes none of the operator's own files: every call
 *     below names the made-up identifier and no other.
 *   - It runs only when an operator presses the button that says all of this.
 *
 * *** CLEAN-UP IS NOT A STEP, IT IS THE `finally`. *** Once a write token has
 * been presented to the files service an object MAY exist — an upload session
 * that failed half-way can leave chunks behind — so the delete is attempted from
 * that point on whatever happened after it, and its own failure is reported
 * rather than swallowed: "the check failed" and "the check failed and left 16 KiB
 * behind" are different facts for the person who has to clean up.
 *
 * *** THE UPLOAD GOES OVER HTTP, ON PURPOSE. *** On the single container, an
 * upload over the socket's FILES_V1 lane does not move the account's usage
 * counter, and deleting such an object then stores a false zero. A diagnostic
 * must not be the thing that corrupts the figure it sits next to, so the write
 * and the delete both use the HTTP lane, whose accounting is symmetrical. The
 * socket lane is exercised where it is safe to: the READ-BACK, which changes
 * nothing.
 *
 * Nothing here formats text and nothing here touches the application: it is
 * handed a port, and returns closed facts for `describeFileTransfer` to word.
 */

/** Two chunks, so the HTTP read-back is two ranged requests and not one whole body. */
export const FILE_TRANSFER_CHUNK_BYTES = 8 * 1024
export const FILE_TRANSFER_CHUNKS = 2
export const FILE_TRANSFER_BYTES = FILE_TRANSFER_CHUNK_BYTES * FILE_TRANSFER_CHUNKS

/** How long the usage counter is given to come back: the accounting is event-driven and may trail the delete. */
export const FILE_TRANSFER_USAGE_SETTLE_MS = 6_000
export const FILE_TRANSFER_USAGE_POLL_MS = 500

/**
 * The first step that failed, in the order they run.
 *
 * *** EXHAUSTIVE AND ORDERED ON PURPOSE. *** Each names the one service
 * boundary it crosses, which is what makes a failure worth more than "it did not
 * work": `authorize-upload` is the auth service refusing to mint, `open` is the
 * files service refusing the token auth just minted.
 */
export const FILE_TRANSFER_STAGES = [
  'authorize-upload',
  'open',
  'send',
  'close',
  'authorize-read',
  'read',
  'compare',
] as const

export type FileTransferStage = (typeof FILE_TRANSFER_STAGES)[number]

export const FILE_SOCKET_READS = ['matched', 'mismatched', 'failed', 'not-negotiated', 'not-reached'] as const

export type FileSocketRead = (typeof FILE_SOCKET_READS)[number]

export const FILE_TRANSFER_CLEANUPS = ['deleted', 'nothing-stored', 'failed'] as const

export type FileTransferCleanup = (typeof FILE_TRANSFER_CLEANUPS)[number]

export const FILE_TRANSFER_USAGES = ['returned', 'not-returned', 'not-reported'] as const

export type FileTransferUsage = (typeof FILE_TRANSFER_USAGES)[number]

export type FileTransferResult = {
  /** The first stage that failed. Absent when the object was stored and read back intact over HTTP. */
  readonly failedAt?: FileTransferStage
  /** The read-back over the socket's FILES_V1 lane, where this tab negotiated it. */
  readonly socketRead: FileSocketRead
  readonly cleanup: FileTransferCleanup
  /** Whether the account's usage counter came back to what it read before the check. */
  readonly usage: FileTransferUsage
}

export type FileTransferOperation = 'write' | 'read' | 'delete'

/**
 * Everything the check does to the outside world, as one narrow port.
 *
 * Each method answers with a plain success or nothing — never an error to format
 * — because the stage that failed is the whole message, and an error's own text
 * is server-controlled and has no business near a copyable report.
 */
export type FileTransferPort = {
  /** An identifier for the throwaway object. Never one that names anything real. */
  readonly newIdentifier: () => string
  readonly randomBytes: (length: number) => Uint8Array
  readonly authorize: (
    remoteIdentifier: string,
    operation: FileTransferOperation,
    bytes: number,
  ) => Promise<string | undefined>
  readonly open: (token: string) => Promise<boolean>
  readonly send: (token: string, chunkId: number, bytes: Uint8Array) => Promise<boolean>
  readonly close: (token: string) => Promise<boolean>
  /** Reads the whole object back over HTTP, one ranged request per chunk. */
  readonly readOverHttp: (
    token: string,
    object: { readonly remoteIdentifier: string; readonly fileUuid: string; readonly chunkSizes: readonly number[] },
  ) => Promise<Uint8Array | undefined>
  /** Whether this tab's socket negotiated FILES_V1 right now. */
  readonly socketLaneNegotiated: () => boolean
  readonly readOverSocket: (object: {
    readonly remoteIdentifier: string
    readonly fileUuid: string
    readonly bytes: number
  }) => Promise<Uint8Array | 'unavailable' | undefined>
  readonly remove: (token: string) => Promise<boolean>
  /** The account's file-usage counter in bytes, or nothing when it cannot be read. */
  readonly usedBytes: () => Promise<number | undefined>
  readonly wait: (ms: number) => Promise<void>
}

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.byteLength !== right.byteLength) {
    return false
  }
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) {
      return false
    }
  }
  return true
}

/** A step that threw is a step that failed: the port's errors are never surfaced, only where they happened. */
async function attempt<T>(step: () => Promise<T>): Promise<T | undefined> {
  try {
    return await step()
  } catch {
    return undefined
  }
}

async function readBackOverSocket(
  port: FileTransferPort,
  object: { readonly remoteIdentifier: string; readonly fileUuid: string },
  expected: Uint8Array,
): Promise<FileSocketRead> {
  if (!port.socketLaneNegotiated()) {
    return 'not-negotiated'
  }

  const received = await attempt(() => port.readOverSocket({ ...object, bytes: expected.byteLength }))
  // The lane can drop between the check above and the open. That is the lane not
  // being available for this read, which is not the lane returning wrong bytes.
  if (received === 'unavailable') {
    return 'not-negotiated'
  }
  if (received === undefined) {
    return 'failed'
  }

  return sameBytes(received, expected) ? 'matched' : 'mismatched'
}

/**
 * Whether the usage counter came back.
 *
 * *** "DID NOT MOVE" IS NOT READ AT ALL. *** Only the before and the after are
 * compared. Whether the counter rose in between is deliberately not a finding:
 * the accounting is event-driven and may not have caught up by the time the
 * object is read back, and on one topology an upload does not move it at all —
 * neither of which says anything about whether the bytes were stored.
 */
async function usageReturned(port: FileTransferPort, before: number | undefined): Promise<FileTransferUsage> {
  if (before === undefined) {
    return 'not-reported'
  }

  for (let waited = 0; waited <= FILE_TRANSFER_USAGE_SETTLE_MS; waited += FILE_TRANSFER_USAGE_POLL_MS) {
    const now = await attempt(() => port.usedBytes())
    if (now === undefined) {
      return 'not-reported'
    }
    if (now === before) {
      return 'returned'
    }
    await port.wait(FILE_TRANSFER_USAGE_POLL_MS)
  }

  return 'not-returned'
}

export async function runFileTransferCheck(port: FileTransferPort): Promise<FileTransferResult> {
  const remoteIdentifier = port.newIdentifier()
  // The socket lane names a file by both identifiers. Nothing in the account has
  // this one, which is the point: it references no item.
  const fileUuid = port.newIdentifier()
  const payload = port.randomBytes(FILE_TRANSFER_BYTES)
  const chunkSizes = Array.from({ length: FILE_TRANSFER_CHUNKS }, () => FILE_TRANSFER_CHUNK_BYTES)

  const usedBefore = await attempt(() => port.usedBytes())

  let failedAt: FileTransferStage | undefined
  let socketRead: FileSocketRead = 'not-reached'
  // From the moment a write token is presented to the files service, an object
  // may exist. Before it, nothing can have been stored and nothing is deleted.
  let mayHaveStored = false

  const transfer = async (): Promise<FileTransferStage | undefined> => {
    const writeToken = await attempt(() => port.authorize(remoteIdentifier, 'write', FILE_TRANSFER_BYTES))
    if (writeToken === undefined) {
      return 'authorize-upload'
    }

    mayHaveStored = true
    if ((await attempt(() => port.open(writeToken))) !== true) {
      return 'open'
    }
    for (let chunk = 0; chunk < FILE_TRANSFER_CHUNKS; chunk++) {
      const bytes = payload.subarray(chunk * FILE_TRANSFER_CHUNK_BYTES, (chunk + 1) * FILE_TRANSFER_CHUNK_BYTES)
      // Chunk ids start at 1: the files service rejects 0.
      if ((await attempt(() => port.send(writeToken, chunk + 1, bytes))) !== true) {
        return 'send'
      }
    }
    if ((await attempt(() => port.close(writeToken))) !== true) {
      return 'close'
    }

    const readToken = await attempt(() => port.authorize(remoteIdentifier, 'read', FILE_TRANSFER_BYTES))
    if (readToken === undefined) {
      return 'authorize-read'
    }
    const received = await attempt(() => port.readOverHttp(readToken, { remoteIdentifier, fileUuid, chunkSizes }))
    if (received === undefined) {
      return 'read'
    }
    if (!sameBytes(received, payload)) {
      return 'compare'
    }

    socketRead = await readBackOverSocket(port, { remoteIdentifier, fileUuid }, payload)

    return undefined
  }

  let cleanup: FileTransferCleanup = 'nothing-stored'
  try {
    failedAt = await transfer()
  } finally {
    if (mayHaveStored) {
      const deleteToken = await attempt(() => port.authorize(remoteIdentifier, 'delete', FILE_TRANSFER_BYTES))
      const removed = deleteToken === undefined ? false : await attempt(() => port.remove(deleteToken))
      cleanup = removed === true ? 'deleted' : 'failed'
    }
  }

  // Compared only once the object is gone: with it still there the counter is
  // SUPPOSED to differ, and "not returned" would be a false alarm about a
  // leftover the cleanup row already reports.
  const usage = cleanup === 'failed' ? 'not-reported' : await usageReturned(port, usedBefore)

  return {
    ...(failedAt === undefined ? {} : { failedAt }),
    socketRead,
    cleanup,
    usage,
  }
}
