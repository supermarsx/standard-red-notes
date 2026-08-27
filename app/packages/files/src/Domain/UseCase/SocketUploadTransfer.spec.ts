import { SocketUploadTransfer, SocketUploadTransferError } from './SocketUploadTransfer'

const DIGEST = 'a'.repeat(64)
const OTHER_DIGEST = 'b'.repeat(64)

describe('SocketUploadTransfer', () => {
  const opened = (subject: SocketUploadTransfer, overrides: Record<string, unknown> = {}) =>
    subject.accepted({
      transferId: 'transfer-1',
      generation: 1,
      resumeId: 'resume-1',
      nextIndex: 0,
      nextOffset: 0,
      declaredSize: 10,
      ...overrides,
    })

  const subject = () => new SocketUploadTransfer(10, DIGEST)

  it('refuses to model a transfer without a real size or digest', () => {
    expect(() => new SocketUploadTransfer(0, DIGEST)).toThrow(SocketUploadTransferError)
    expect(() => new SocketUploadTransfer(10, 'not-a-digest')).toThrow(SocketUploadTransferError)
  })

  it('opens a fresh transfer before anything is known', () => {
    expect(subject().nextAction()).toEqual({ type: 'open' })
  })

  it('sends chunks from wherever the server says it is, not from where the client last sent', () => {
    const transfer = subject()
    opened(transfer)

    expect(transfer.nextAction()).toEqual({
      type: 'send-chunk',
      index: 0,
      offset: 0,
      transferId: 'transfer-1',
      generation: 1,
    })

    transfer.chunkAcknowledged({
      transferId: 'transfer-1',
      generation: 1,
      nextIndex: 1,
      nextOffset: 4,
      resumeId: 'resume-1',
    })

    expect(transfer.nextAction()).toEqual({
      type: 'send-chunk',
      index: 1,
      offset: 4,
      transferId: 'transfer-1',
      generation: 1,
    })
  })

  it('finishes once the server confirms every declared byte is stored', () => {
    const transfer = subject()
    opened(transfer)
    transfer.chunkAcknowledged({
      transferId: 'transfer-1',
      generation: 1,
      nextIndex: 1,
      nextOffset: 10,
      resumeId: 'resume-1',
    })

    expect(transfer.nextAction()).toEqual({
      type: 'finish',
      transferId: 'transfer-1',
      generation: 1,
      sha256: DIGEST,
    })
  })

  describe('socket loss', () => {
    it('resumes the same transfer rather than restarting the upload', () => {
      const transfer = subject()
      opened(transfer)
      transfer.chunkAcknowledged({
        transferId: 'transfer-1',
        generation: 1,
        nextIndex: 1,
        nextOffset: 4,
        resumeId: 'resume-2',
      })

      transfer.socketLost()

      // Not `{ type: 'open' }` — that would begin a second upload of the same file.
      expect(transfer.nextAction()).toEqual({ type: 'open', resumeId: 'resume-2' })
    })

    it('adopts the server’s rewound position and new generation on resume', () => {
      const transfer = subject()
      opened(transfer)
      transfer.chunkAcknowledged({
        transferId: 'transfer-1',
        generation: 1,
        nextIndex: 2,
        nextOffset: 8,
        resumeId: 'resume-2',
      })
      transfer.socketLost()

      // The server accepted less than the client had sent: only 4 bytes were
      // actually stored, and the buffered remainder was discarded.
      transfer.accepted({
        transferId: 'transfer-1',
        generation: 2,
        resumeId: 'resume-3',
        nextIndex: 1,
        nextOffset: 4,
        declaredSize: 10,
      })

      expect(transfer.nextAction()).toEqual({
        type: 'send-chunk',
        index: 1,
        offset: 4,
        transferId: 'transfer-1',
        generation: 2,
      })
    })

    it('is safe to fall back to HTTP while nothing has been published', () => {
      const transfer = subject()
      opened(transfer)
      transfer.chunkAcknowledged({
        transferId: 'transfer-1',
        generation: 1,
        nextIndex: 1,
        nextOffset: 4,
        resumeId: 'resume-2',
      })
      transfer.socketLost()

      // Bytes were stored, but the server publishes only at FINISH, so an HTTP
      // restart cannot produce a second published object.
      expect(transfer.safeToFallback).toBe(true)
    })

    it('abandons safely when the socket dies before anything was sent', () => {
      const transfer = subject()
      transfer.socketLost()

      expect(transfer.nextAction()).toEqual({ type: 'abandon', code: 'SOCKET_CLOSED', safeToFallback: true })
    })
  })

  describe('an interrupted FINISH', () => {
    const finishing = () => {
      const transfer = subject()
      opened(transfer)
      transfer.chunkAcknowledged({
        transferId: 'transfer-1',
        generation: 1,
        nextIndex: 1,
        nextOffset: 10,
        resumeId: 'resume-2',
      })
      transfer.finishSent()
      return transfer
    }

    it('is never safe to replay over HTTP, because the upload may already be applied', () => {
      const transfer = finishing()

      expect(transfer.safeToFallback).toBe(false)

      transfer.socketLost()
      expect(transfer.safeToFallback).toBe(false)
    })

    it('resolves by re-sending the identical FINISH rather than re-uploading', () => {
      const transfer = finishing()
      transfer.socketLost()

      expect(transfer.nextAction()).toEqual({ type: 'open', resumeId: 'resume-2' })

      // The resume lands on a fully-stored stream, so there is nothing to re-send;
      // the only open question is what the earlier FINISH decided.
      transfer.accepted({
        transferId: 'transfer-1',
        generation: 2,
        resumeId: 'resume-3',
        nextIndex: 1,
        nextOffset: 10,
        declaredSize: 10,
      })

      expect(transfer.nextAction()).toEqual({
        type: 'finish',
        transferId: 'transfer-1',
        generation: 2,
        sha256: DIGEST,
      })
    })

    it('sends byte-identical FINISH arguments across attempts, which is what makes it idempotent', () => {
      const transfer = finishing()
      const first = transfer.nextAction()
      transfer.socketLost()
      transfer.accepted({
        transferId: 'transfer-1',
        generation: 2,
        resumeId: 'resume-3',
        nextIndex: 1,
        nextOffset: 10,
        declaredSize: 10,
      })
      const second = transfer.nextAction()

      // The digest must be identical: an identical digest is what the server
      // treats as a re-read, and a differing one is FILE_INTEGRITY_MISMATCH.
      expect(first).toMatchObject({ type: 'finish', sha256: DIGEST })
      expect(second).toMatchObject({ type: 'finish', sha256: DIGEST })
    })

    it('stays unsafe to replay even after resuming, until it is actually decided', () => {
      const transfer = finishing()
      transfer.socketLost()
      transfer.accepted({
        transferId: 'transfer-1',
        generation: 2,
        resumeId: 'resume-3',
        nextIndex: 1,
        nextOffset: 10,
        declaredSize: 10,
      })

      expect(transfer.safeToFallback).toBe(false)
    })
  })

  describe('completion and refusal', () => {
    const readyToFinish = () => {
      const transfer = subject()
      opened(transfer)
      transfer.chunkAcknowledged({
        transferId: 'transfer-1',
        generation: 1,
        nextIndex: 1,
        nextOffset: 10,
        resumeId: 'resume-2',
      })
      transfer.finishSent()
      return transfer
    }

    it('completes when the server returns the digest this client computed', () => {
      const transfer = readyToFinish()
      transfer.completed(DIGEST)

      expect(transfer.nextAction()).toEqual({ type: 'done', sha256: DIGEST })
    })

    it('treats a differing completion digest as an integrity failure, never a retry', () => {
      const transfer = readyToFinish()
      transfer.completed(OTHER_DIGEST)

      expect(transfer.nextAction()).toEqual({
        type: 'abandon',
        code: 'FILE_INTEGRITY_MISMATCH',
        safeToFallback: false,
      })
    })

    it('refuses an accepted size that disagrees with the client’s own stream', () => {
      const transfer = subject()
      opened(transfer, { declaredSize: 11 })

      expect(transfer.nextAction()).toMatchObject({ type: 'abandon', code: 'FILE_INVALID_STATE' })
    })

    it('refuses an acknowledgement that moves the transfer backwards', () => {
      const transfer = subject()
      opened(transfer)
      transfer.chunkAcknowledged({
        transferId: 'transfer-1',
        generation: 1,
        nextIndex: 2,
        nextOffset: 8,
        resumeId: 'resume-2',
      })
      transfer.chunkAcknowledged({
        transferId: 'transfer-1',
        generation: 1,
        nextIndex: 1,
        nextOffset: 4,
        resumeId: 'resume-2',
      })

      expect(transfer.nextAction()).toMatchObject({ type: 'abandon', code: 'FILE_INVALID_STATE' })
    })

    it('ignores a late acknowledgement from a superseded generation', () => {
      const transfer = subject()
      opened(transfer)
      transfer.socketLost()
      transfer.accepted({
        transferId: 'transfer-1',
        generation: 2,
        resumeId: 'resume-3',
        nextIndex: 0,
        nextOffset: 0,
        declaredSize: 10,
      })

      // Arrives from the previous attempt; acting on it would advance this
      // generation past bytes that were discarded when the server rewound.
      transfer.chunkAcknowledged({
        transferId: 'transfer-1',
        generation: 1,
        nextIndex: 2,
        nextOffset: 8,
        resumeId: 'resume-2',
      })

      expect(transfer.nextAction()).toEqual({
        type: 'send-chunk',
        index: 0,
        offset: 0,
        transferId: 'transfer-1',
        generation: 2,
      })
    })

    it('reports a server error before FINISH as safe to fall back', () => {
      const transfer = subject()
      opened(transfer)
      transfer.serverError('FILE_BACKEND_ERROR')

      expect(transfer.nextAction()).toEqual({
        type: 'abandon',
        code: 'FILE_BACKEND_ERROR',
        safeToFallback: true,
      })
    })

    it('reports a server error after FINISH as unsafe to fall back', () => {
      const transfer = readyToFinish()
      transfer.serverError('FILE_BACKEND_ERROR')

      expect(transfer.nextAction()).toEqual({
        type: 'abandon',
        code: 'FILE_BACKEND_ERROR',
        safeToFallback: false,
      })
    })

    it('does not let a late event resurrect a completed transfer', () => {
      const transfer = readyToFinish()
      transfer.completed(DIGEST)
      transfer.socketLost()
      transfer.serverError('FILE_BACKEND_ERROR')

      expect(transfer.nextAction()).toEqual({ type: 'done', sha256: DIGEST })
    })
  })
})
