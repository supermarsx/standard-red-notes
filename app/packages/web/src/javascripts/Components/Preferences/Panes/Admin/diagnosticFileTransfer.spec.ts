import {
  FILE_TRANSFER_BYTES,
  FILE_TRANSFER_CHUNK_BYTES,
  FILE_TRANSFER_CHUNKS,
  FILE_TRANSFER_STAGES,
  runFileTransferCheck,
  type FileTransferOperation,
  type FileTransferPort,
  type FileTransferStage,
} from './diagnosticFileTransfer'

/**
 * A files service small enough to read, with a switch on every boundary.
 *
 * It STORES what is sent and serves what was stored, so "the bytes read back are
 * the bytes sent" is a real comparison here and not two references to one array.
 * Every call is logged with the identifier it named, which is how the tests below
 * can say the check touched nothing but its own object.
 */
type Call = { readonly step: string; readonly identifier?: string }

type Faults = {
  refuseAuthorize?: FileTransferOperation
  refuseOpen?: boolean
  refuseSendOfChunk?: number
  refuseClose?: boolean
  refuseHttpRead?: boolean
  corruptHttpRead?: boolean
  socketLane?: 'matched' | 'corrupt' | 'fails' | 'drops' | 'not-negotiated'
  refuseDelete?: boolean
  throwAt?: string
  /** Bytes the counter keeps after the object is gone. */
  usageResidue?: number
  usageUnreadable?: boolean
  /** How many reads the counter takes to settle after the delete. */
  usageSettlesAfterReads?: number
}

const service = (faults: Faults = {}) => {
  const calls: Call[] = []
  const stored = new Map<string, Uint8Array[]>()
  const tokens = new Map<string, { identifier: string; operation: FileTransferOperation }>()
  let identifiers = 0
  let seed = 1
  let used = 5_000_000
  let readsSinceDelete = 0
  let deleted = false
  let waited = 0

  const note = (step: string, identifier?: string) => {
    calls.push(identifier === undefined ? { step } : { step, identifier })
    if (faults.throwAt === step) {
      throw new Error(`https://files.internal.example/secret-path refused ${step}`)
    }
  }
  const objectOf = (identifier: string): Uint8Array => {
    const chunks = stored.get(identifier) ?? []
    const whole = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
    let offset = 0
    for (const chunk of chunks) {
      whole.set(chunk, offset)
      offset += chunk.byteLength
    }
    return whole
  }
  const corrupted = (bytes: Uint8Array): Uint8Array => {
    const copy = bytes.slice()
    copy[copy.byteLength - 1] ^= 0xff
    return copy
  }

  const port: FileTransferPort = {
    newIdentifier: () => `made-up-${++identifiers}`,
    randomBytes: (length) => {
      const bytes = new Uint8Array(length)
      for (let index = 0; index < length; index++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        bytes[index] = seed & 0xff
      }
      return bytes
    },
    authorize: async (identifier, operation) => {
      note(`authorize-${operation}`, identifier)
      if (faults.refuseAuthorize === operation) {
        return undefined
      }
      const token = `token-${operation}-${tokens.size}`
      tokens.set(token, { identifier, operation })
      return token
    },
    open: async (token) => {
      note('open', tokens.get(token)?.identifier)
      if (faults.refuseOpen) {
        return false
      }
      stored.set(tokens.get(token)?.identifier as string, [])
      return true
    },
    send: async (token, chunkId, bytes) => {
      const identifier = tokens.get(token)?.identifier as string
      note(`send-${chunkId}`, identifier)
      if (faults.refuseSendOfChunk === chunkId) {
        return false
      }
      stored.get(identifier)?.push(bytes.slice())
      used += bytes.byteLength
      return true
    },
    close: async (token) => {
      note('close', tokens.get(token)?.identifier)
      return faults.refuseClose !== true
    },
    readOverHttp: async (token, object) => {
      note('read-http', object.remoteIdentifier)
      expect(tokens.get(token)).toEqual({ identifier: object.remoteIdentifier, operation: 'read' })
      if (faults.refuseHttpRead) {
        return undefined
      }
      const whole = objectOf(object.remoteIdentifier)
      return faults.corruptHttpRead ? corrupted(whole) : whole
    },
    socketLaneNegotiated: () => (faults.socketLane ?? 'matched') !== 'not-negotiated',
    readOverSocket: async (object) => {
      note('read-socket', object.remoteIdentifier)
      const lane = faults.socketLane ?? 'matched'
      if (lane === 'drops') {
        return 'unavailable'
      }
      if (lane === 'fails') {
        return undefined
      }
      const whole = objectOf(object.remoteIdentifier)
      return lane === 'corrupt' ? corrupted(whole) : whole
    },
    remove: async (token) => {
      const identifier = tokens.get(token)?.identifier as string
      note('remove', identifier)
      expect(tokens.get(token)?.operation).toBe('delete')
      if (faults.refuseDelete) {
        return false
      }
      used -= objectOf(identifier).byteLength - (faults.usageResidue ?? 0)
      stored.delete(identifier)
      deleted = true
      return true
    },
    usedBytes: async () => {
      note('used')
      if (faults.usageUnreadable) {
        return undefined
      }
      if (deleted && faults.usageSettlesAfterReads !== undefined) {
        readsSinceDelete += 1
        // The accounting trails the delete: it still shows the object for a while.
        return readsSinceDelete > faults.usageSettlesAfterReads ? used : used + FILE_TRANSFER_BYTES
      }
      return used
    },
    wait: async (ms) => {
      waited += ms
    },
  }

  return {
    port,
    calls,
    stored,
    stepsOf: () => calls.map((call) => call.step).filter((step) => step !== 'used'),
    waited: () => waited,
  }
}

describe('the file-transfer round trip', () => {
  it('stores one object, reads it back over HTTP and the socket, and deletes it', async () => {
    const files = service()

    const result = await runFileTransferCheck(files.port)

    expect(result).toEqual({ socketRead: 'matched', cleanup: 'deleted', usage: 'returned' })
    expect(files.stepsOf()).toEqual([
      'authorize-write',
      'open',
      'send-1',
      'send-2',
      'close',
      'authorize-read',
      'read-http',
      'read-socket',
      'authorize-delete',
      'remove',
    ])
    // Nothing is left behind.
    expect(files.stored.size).toBe(0)
  })

  it('sends the declared size in chunks whose ids start at 1', async () => {
    const files = service()
    const sent: number[] = []
    const send = files.port.send
    const port: FileTransferPort = {
      ...files.port,
      send: async (token, chunkId, bytes) => {
        sent.push(bytes.byteLength)
        expect(chunkId).toBeGreaterThanOrEqual(1)
        return send(token, chunkId, bytes)
      },
    }

    await runFileTransferCheck(port)

    expect(sent).toEqual(Array.from({ length: FILE_TRANSFER_CHUNKS }, () => FILE_TRANSFER_CHUNK_BYTES))
    expect(sent.reduce((total, bytes) => total + bytes, 0)).toBe(FILE_TRANSFER_BYTES)
  })

  /**
   * *** IT NAMES ITS OWN OBJECT AND NOTHING ELSE. *** Every call that takes an
   * identifier takes one this check made up, so there is no path by which it can
   * read, overwrite or delete a file that belongs to the account.
   */
  it('never names an identifier it did not make up', async () => {
    const files = service()

    await runFileTransferCheck(files.port)

    const named = files.calls.flatMap((call) => (call.identifier === undefined ? [] : [call.identifier]))
    expect(named.length).toBeGreaterThan(8)
    expect([...new Set(named)]).toEqual(['made-up-1'])
  })

  it('says the socket lane was not exercised when this tab did not negotiate it, and still passes over HTTP', async () => {
    const files = service({ socketLane: 'not-negotiated' })

    const result = await runFileTransferCheck(files.port)

    expect(result).toEqual({ socketRead: 'not-negotiated', cleanup: 'deleted', usage: 'returned' })
    expect(files.stepsOf()).not.toContain('read-socket')
  })

  it('tells a lane that dropped before the read from one that returned the wrong bytes or nothing', async () => {
    expect((await runFileTransferCheck(service({ socketLane: 'drops' }).port)).socketRead).toBe('not-negotiated')
    expect((await runFileTransferCheck(service({ socketLane: 'corrupt' }).port)).socketRead).toBe('mismatched')
    expect((await runFileTransferCheck(service({ socketLane: 'fails' }).port)).socketRead).toBe('failed')
    // None of them is a failed transfer: the object was stored and read back over HTTP.
    for (const socketLane of ['drops', 'corrupt', 'fails'] as const) {
      expect((await runFileTransferCheck(service({ socketLane }).port)).failedAt).toBeUndefined()
    }
  })

  /**
   * *** CLEAN-UP ON EVERY HALF-WAY FAILURE. *** One fault per stage. From the
   * moment a write token is presented to the files service an object may exist,
   * so every later failure still deletes — and the one earlier failure deletes
   * nothing, because there is nothing and a delete would be a write of its own.
   */
  const FAULT_AT: Record<FileTransferStage, Faults> = {
    'authorize-upload': { refuseAuthorize: 'write' },
    open: { refuseOpen: true },
    send: { refuseSendOfChunk: 2 },
    close: { refuseClose: true },
    'authorize-read': { refuseAuthorize: 'read' },
    read: { refuseHttpRead: true },
    compare: { corruptHttpRead: true },
  }

  it('covers every stage in the loop below', () => {
    expect(Object.keys(FAULT_AT).sort()).toEqual([...FILE_TRANSFER_STAGES].sort())
  })

  for (const stage of FILE_TRANSFER_STAGES) {
    it(`names "${stage}" as the step that failed, and cleans up after it`, async () => {
      const files = service(FAULT_AT[stage])

      const result = await runFileTransferCheck(files.port)

      expect(result.failedAt).toBe(stage)
      expect(result.socketRead).toBe('not-reached')
      if (stage === 'authorize-upload') {
        expect(result.cleanup).toBe('nothing-stored')
        expect(files.stepsOf()).toEqual(['authorize-write'])
      } else {
        expect(result.cleanup).toBe('deleted')
        expect(files.stepsOf().slice(-2)).toEqual(['authorize-delete', 'remove'])
        expect(files.stored.size).toBe(0)
      }
    })
  }

  it('treats a step that throws as a step that failed, and still cleans up', async () => {
    for (const throwAt of ['open', 'send-1', 'close', 'read-http']) {
      const files = service({ throwAt })

      const result = await runFileTransferCheck(files.port)

      expect({ throwAt, failed: result.failedAt !== undefined, cleanup: result.cleanup }).toEqual({
        throwAt,
        failed: true,
        cleanup: 'deleted',
      })
      // The error's own text is server-controlled and goes nowhere.
      expect(JSON.stringify(result)).not.toContain('files.internal.example')
    }
  })

  it('reports a delete that failed, rather than swallowing it', async () => {
    const refused = service({ refuseDelete: true })
    const unauthorized = service({ refuseAuthorize: 'delete' })
    const threw = service({ throwAt: 'remove' })

    expect((await runFileTransferCheck(refused.port)).cleanup).toBe('failed')
    expect((await runFileTransferCheck(unauthorized.port)).cleanup).toBe('failed')
    expect((await runFileTransferCheck(threw.port)).cleanup).toBe('failed')
    // And the object really is still there in the case where it would be.
    expect(refused.stored.size).toBe(1)
  })

  /**
   * *** THE COUNTER IS COMPARED BEFORE AND AFTER, AND NEVER IN BETWEEN. ***
   * Whether it rose while the object existed is not read: the accounting trails
   * the transfer, and on one topology an upload does not move it at all.
   */
  describe('the usage counter', () => {
    it('is back where it was after an ordinary run', async () => {
      expect((await runFileTransferCheck(service().port)).usage).toBe('returned')
    })

    it('is given time to settle, and is only "not returned" when it never does', async () => {
      const slow = service({ usageSettlesAfterReads: 3 })
      const stuck = service({ usageResidue: FILE_TRANSFER_BYTES })

      expect((await runFileTransferCheck(slow.port)).usage).toBe('returned')
      expect(slow.waited()).toBeGreaterThan(0)
      expect((await runFileTransferCheck(stuck.port)).usage).toBe('not-returned')
    })

    it('says it could not be read, and claims nothing, when it could not', async () => {
      expect((await runFileTransferCheck(service({ usageUnreadable: true }).port)).usage).toBe('not-reported')
      expect((await runFileTransferCheck(service({ throwAt: 'used' }).port)).usage).toBe('not-reported')
    })

    it('is not compared while the object is still there', async () => {
      // With the delete refused the counter is SUPPOSED to differ; calling that
      // "not returned" would be a second alarm about the leftover.
      expect((await runFileTransferCheck(service({ refuseDelete: true }).port)).usage).toBe('not-reported')
    })

    it('does not turn a transfer that worked into a failure', async () => {
      const result = await runFileTransferCheck(service({ usageResidue: FILE_TRANSFER_BYTES }).port)

      expect(result.failedAt).toBeUndefined()
      expect(result.socketRead).toBe('matched')
      expect(result.cleanup).toBe('deleted')
    })
  })
})
