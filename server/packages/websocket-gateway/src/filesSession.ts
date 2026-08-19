import { createHash } from 'node:crypto'
import jwt from 'jsonwebtoken'

import type { SyncTicketIdentity } from './auth.js'
import {
  DEFAULT_FILE_TRANSFER_DEADLINE_MS,
  MAX_FILE_CHUNK_BYTES,
  MAX_FILE_TRANSFER_CREDIT_BYTES,
  decodeFileBinaryFrame,
  encodeFileBinaryFrame,
  sha256Hex,
  type FileBinaryHeader,
  type FileResourceReference,
  type FileUploadDescriptor,
} from './filesProtocol.js'
import type {
  JsonObject,
  SyncFilesCancelFrame,
  SyncFilesCreditFrame,
  SyncFilesDownloadOpenFrame,
  SyncFilesMetadataFrame,
  SyncFilesUploadFinishFrame,
  SyncFilesUploadOpenFrame,
  SyncServerFrameType,
} from './syncProtocol.js'

export type SyncFilesControlFrame =
  | SyncFilesMetadataFrame
  | SyncFilesUploadOpenFrame
  | SyncFilesUploadFinishFrame
  | SyncFilesDownloadOpenFrame
  | SyncFilesCreditFrame
  | SyncFilesCancelFrame

export type SyncFileMetadataResult = {
  resource: FileResourceReference
  exists: boolean
  encryptedSize?: number
}

export type SyncFileUploadOpenResult = {
  transferId: string
  generation: number
  resumeId: string
  nextIndex: number
  nextOffset: number
  declaredSize: number
}

export type SyncFileUploadChunkResult = {
  duplicate: boolean
  nextIndex: number
  nextOffset: number
  resumeId: string
}

export type SyncFileDownloadOpenResult = {
  transferId: string
  generation: number
  resumeId: string
  declaredSize: number
  nextIndex: number
  nextOffset: number
}

export type SyncFileDownloadChunk = {
  index: number
  offset: number
  declaredSize: number
  bytes: Uint8Array
  final: boolean
}

export interface SyncFilesAdapter {
  ready(): boolean
  metadata(
    input: { identity: SyncTicketIdentity; resources: FileResourceReference[] },
    signal: AbortSignal,
  ): Promise<SyncFileMetadataResult[]>
  openUpload(
    input: { identity: SyncTicketIdentity; descriptor: FileUploadDescriptor },
    signal: AbortSignal,
  ): Promise<SyncFileUploadOpenResult>
  uploadChunk(
    input: { identity: SyncTicketIdentity; header: FileBinaryHeader; bytes: Uint8Array },
    signal: AbortSignal,
  ): Promise<SyncFileUploadChunkResult>
  finishUpload(
    input: {
      identity: SyncTicketIdentity
      transferId: string
      generation: number
      declaredSize: number
      sha256: string
    },
    signal: AbortSignal,
  ): Promise<{ sha256: string }>
  openDownload(
    input: {
      identity: SyncTicketIdentity
      resource: FileResourceReference
      offset: number
      resumeId?: string
    },
    signal: AbortSignal,
  ): Promise<SyncFileDownloadOpenResult>
  readDownloadChunk(
    input: {
      identity: SyncTicketIdentity
      transferId: string
      generation: number
      index: number
      offset: number
      maxBytes: number
    },
    signal: AbortSignal,
  ): Promise<SyncFileDownloadChunk>
  cancel(input: { identity: SyncTicketIdentity; transferId: string; generation: number; reason: string }): Promise<void>
}

export interface SyncFilesSessionMetrics {
  increment(event: string, code?: string): void
}

/**
 * Minimal decoder seam consumed by adapter-side FILES_V1 authorizers (the
 * home-server authorizer re-validates the live session token and the canonical
 * valet token on every operation).
 */
export interface SyncFilesSignedTokenDecoder<T> {
  decodeToken(token: string): T | undefined
}

/**
 * HS256-only signed-token decoder. Bootstraps that own a FILES_V1 adapter need
 * to verify the cross-service and valet tokens minted elsewhere in the server;
 * this is the same verification contract `decodeCrossServiceToken` uses, minus
 * the payload shape. Rejects (returns undefined) on any verification failure so
 * callers can fail closed.
 */
export function createSyncFilesTokenDecoder<T>(secret: string): SyncFilesSignedTokenDecoder<T> {
  if (!secret) {
    throw new Error('A signing secret is required to decode FILES_V1 authorization tokens.')
  }
  return {
    decodeToken(token: string): T | undefined {
      try {
        const decoded = jwt.verify(token, secret, { algorithms: ['HS256'], clockTolerance: 10 })
        return typeof decoded === 'object' && decoded !== null ? (decoded as T) : undefined
      } catch {
        return undefined
      }
    },
  }
}

export type SyncFilesSessionOptions = {
  adapter: SyncFilesAdapter
  sendControl: (type: SyncServerFrameType, requestId: string, commandId: string, payload: JsonObject) => boolean
  sendBinary: (bytes: Uint8Array) => boolean
  sendError: (requestId: string, commandId: string, code: string) => boolean
  metrics?: SyncFilesSessionMetrics
}

type ActiveDownload = {
  identity: SyncTicketIdentity
  requestId: string
  commandId: string
  transferId: string
  generation: number
  declaredSize: number
  nextIndex: number
  nextOffset: number
  rangeStart: number
  creditBytes: number
  deadlineMs: number
  controller: AbortController
  digest: ReturnType<typeof createHash>
  pumping: boolean
}

export class SyncFilesSession {
  private readonly downloads = new Map<string, ActiveDownload>()
  private disconnected = false

  constructor(private readonly options: SyncFilesSessionOptions) {}

  async handleControl(frame: SyncFilesControlFrame, identity: SyncTicketIdentity): Promise<void> {
    if (this.disconnected || !this.options.adapter.ready()) {
      this.options.sendError(frame.requestId, frame.commandId, 'OPERATION_UNAVAILABLE')
      return
    }
    try {
      switch (frame.type) {
        case 'FILES_METADATA': {
          const entries = await this.withDeadline(frame.payload.deadlineMs, (signal) =>
            this.options.adapter.metadata({ identity, resources: frame.payload.resources }, signal),
          )
          this.options.sendControl('FILES_METADATA', frame.requestId, frame.commandId, { entries })
          this.options.metrics?.increment('files', 'metadata')
          return
        }
        case 'FILES_UPLOAD_OPEN': {
          const descriptor: FileUploadDescriptor = {
            ...frame.payload.resource,
            decryptedSize: frame.payload.decryptedSize,
            declaredSize: frame.payload.declaredSize,
            mimeType: frame.payload.mimeType,
            ...(frame.payload.resumeId ? { resumeId: frame.payload.resumeId } : {}),
          }
          const opened = await this.withDeadline(frame.payload.deadlineMs, (signal) =>
            this.options.adapter.openUpload({ identity, descriptor }, signal),
          )
          this.options.sendControl('FILES_ACCEPTED', frame.requestId, frame.commandId, {
            mode: 'upload',
            ...opened,
            maxChunkBytes: MAX_FILE_CHUNK_BYTES,
          })
          this.options.metrics?.increment('files', frame.payload.resumeId ? 'upload_resumed' : 'upload_opened')
          return
        }
        case 'FILES_UPLOAD_FINISH': {
          const completed = await this.withDeadline(frame.payload.deadlineMs, (signal) =>
            this.options.adapter.finishUpload(
              {
                identity,
                transferId: frame.payload.transferId,
                generation: frame.payload.generation,
                declaredSize: frame.payload.declaredSize,
                sha256: frame.payload.sha256,
              },
              signal,
            ),
          )
          this.options.sendControl('FILES_COMPLETE', frame.requestId, frame.commandId, {
            mode: 'upload',
            transferId: frame.payload.transferId,
            generation: frame.payload.generation,
            sha256: completed.sha256,
          })
          this.options.metrics?.increment('files', 'upload_completed')
          return
        }
        case 'FILES_DOWNLOAD_OPEN': {
          const opened = await this.withDeadline(frame.payload.deadlineMs, (signal) =>
            this.options.adapter.openDownload(
              {
                identity,
                resource: frame.payload.resource,
                offset: frame.payload.offset,
                ...(frame.payload.resumeId ? { resumeId: frame.payload.resumeId } : {}),
              },
              signal,
            ),
          )
          if (opened.nextOffset > opened.declaredSize || opened.nextOffset < frame.payload.offset) {
            throw new SyncFilesError('FILE_INVALID_STATE', false)
          }
          const active: ActiveDownload = {
            identity,
            requestId: frame.requestId,
            commandId: frame.commandId,
            transferId: opened.transferId,
            generation: opened.generation,
            declaredSize: opened.declaredSize,
            nextIndex: opened.nextIndex,
            nextOffset: opened.nextOffset,
            rangeStart: opened.nextOffset,
            creditBytes: frame.payload.initialCreditBytes,
            deadlineMs: frame.payload.deadlineMs,
            controller: new AbortController(),
            digest: createHash('sha256'),
            pumping: false,
          }
          const previous = this.downloads.get(opened.transferId)
          previous?.controller.abort(new Error('download-generation-replaced'))
          this.downloads.set(opened.transferId, active)
          this.options.sendControl('FILES_ACCEPTED', frame.requestId, frame.commandId, {
            mode: 'download',
            ...opened,
            maxChunkBytes: MAX_FILE_CHUNK_BYTES,
          })
          this.options.metrics?.increment('files', frame.payload.resumeId ? 'download_resumed' : 'download_opened')
          void this.pumpDownload(active)
          return
        }
        case 'FILES_CREDIT': {
          const active = this.currentDownload(frame.payload.transferId, frame.payload.generation)
          active.creditBytes = Math.min(MAX_FILE_TRANSFER_CREDIT_BYTES, active.creditBytes + frame.payload.creditBytes)
          void this.pumpDownload(active)
          return
        }
        case 'FILES_CANCEL': {
          await this.cancelTransfer(identity, frame.payload.transferId, frame.payload.generation, 'client-cancelled')
          this.options.sendControl('FILES_COMPLETE', frame.requestId, frame.commandId, {
            mode: 'cancelled',
            transferId: frame.payload.transferId,
            generation: frame.payload.generation,
          })
          return
        }
      }
    } catch (error) {
      const normalized = normalizeFilesError(error)
      this.options.metrics?.increment('files', normalized.code.toLowerCase())
      this.options.sendError(frame.requestId, frame.commandId, normalized.code)
    }
  }

  async handleBinary(raw: Uint8Array, identity: SyncTicketIdentity): Promise<void> {
    let decoded: ReturnType<typeof decodeFileBinaryFrame> | undefined
    try {
      if (this.disconnected || !this.options.adapter.ready()) {
        throw new SyncFilesError('OPERATION_UNAVAILABLE', true)
      }
      decoded = decodeFileBinaryFrame(raw)
      if (decoded.header.kind !== 'UPLOAD_CHUNK') {
        throw new SyncFilesError('FILE_DIRECTION_INVALID', false)
      }
      const result = await this.withDeadline(DEFAULT_FILE_TRANSFER_DEADLINE_MS, (signal) =>
        this.options.adapter.uploadChunk({ identity, header: decoded!.header, bytes: decoded!.bytes }, signal),
      )
      this.options.sendControl('FILES_CHUNK_ACK', decoded.header.requestId, decoded.header.transferId, {
        transferId: decoded.header.transferId,
        generation: decoded.header.generation,
        index: decoded.header.index,
        duplicate: result.duplicate,
        nextIndex: result.nextIndex,
        nextOffset: result.nextOffset,
        resumeId: result.resumeId,
      })
      this.options.metrics?.increment('files', result.duplicate ? 'upload_duplicate' : 'upload_chunk')
    } catch (error) {
      const normalized = normalizeFilesError(error)
      this.options.metrics?.increment('files', normalized.code.toLowerCase())
      this.options.sendError(
        decoded?.header.requestId ?? 'files-binary',
        decoded?.header.transferId ?? 'files-binary',
        normalized.code,
      )
    } finally {
      decoded?.bytes.fill(0)
    }
  }

  disconnect(): void {
    if (this.disconnected) {
      return
    }
    this.disconnected = true
    for (const active of this.downloads.values()) {
      active.controller.abort(new Error('socket-disconnected'))
    }
    this.downloads.clear()
  }

  private async pumpDownload(active: ActiveDownload): Promise<void> {
    if (active.pumping || active.controller.signal.aborted || this.disconnected) {
      return
    }
    active.pumping = true
    try {
      while (active.creditBytes > 0 && !active.controller.signal.aborted && !this.disconnected) {
        const maxBytes = Math.min(MAX_FILE_CHUNK_BYTES, active.creditBytes, active.declaredSize - active.nextOffset)
        if (maxBytes <= 0) {
          throw new SyncFilesError('FILE_INVALID_STATE', false)
        }
        const chunk = await this.withDeadline(
          active.deadlineMs,
          (signal) =>
            this.options.adapter.readDownloadChunk(
              {
                identity: active.identity,
                transferId: active.transferId,
                generation: active.generation,
                index: active.nextIndex,
                offset: active.nextOffset,
                maxBytes,
              },
              signal,
            ),
          active.controller.signal,
        )
        if (!this.isCurrentDownload(active) || active.controller.signal.aborted || this.disconnected) {
          chunk.bytes.fill(0)
          return
        }
        if (
          chunk.index !== active.nextIndex ||
          chunk.offset !== active.nextOffset ||
          chunk.declaredSize !== active.declaredSize ||
          chunk.bytes.byteLength < 1 ||
          chunk.bytes.byteLength > maxBytes ||
          chunk.final !== (chunk.offset + chunk.bytes.byteLength === chunk.declaredSize)
        ) {
          chunk.bytes.fill(0)
          throw new SyncFilesError('FILE_INVALID_STATE', false)
        }
        const header: FileBinaryHeader = {
          kind: 'DOWNLOAD_CHUNK',
          requestId: active.requestId,
          transferId: active.transferId,
          generation: active.generation,
          index: chunk.index,
          offset: chunk.offset,
          declaredSize: chunk.declaredSize,
          byteLength: chunk.bytes.byteLength,
          sha256: sha256Hex(chunk.bytes),
          final: chunk.final,
        }
        active.digest.update(chunk.bytes)
        const encoded = encodeFileBinaryFrame(header, chunk.bytes)
        chunk.bytes.fill(0)
        if (!this.options.sendBinary(encoded)) {
          throw new SyncFilesError('FILE_BACKPRESSURE', true)
        }
        active.creditBytes -= header.byteLength
        active.nextIndex += 1
        active.nextOffset += header.byteLength
        if (header.final) {
          if (!this.deleteCurrentDownload(active)) {
            return
          }
          this.options.sendControl('FILES_COMPLETE', active.requestId, active.commandId, {
            mode: 'download',
            transferId: active.transferId,
            generation: active.generation,
            sha256: active.digest.digest('hex'),
            rangeStart: active.rangeStart,
            declaredSize: active.declaredSize,
          })
          this.options.metrics?.increment('files', 'download_completed')
          return
        }
      }
      this.options.metrics?.increment('files', 'backpressure_wait')
    } catch (error) {
      const wasCurrent = this.deleteCurrentDownload(active)
      active.controller.abort(error)
      if (wasCurrent && !this.disconnected) {
        const normalized = normalizeFilesError(error)
        this.options.sendError(active.requestId, active.commandId, normalized.code)
        await this.options.adapter
          .cancel({
            identity: active.identity,
            transferId: active.transferId,
            generation: active.generation,
            reason: 'download-failed',
          })
          .catch(() => undefined)
      }
    } finally {
      active.pumping = false
    }
  }

  private currentDownload(transferId: string, generation: number): ActiveDownload {
    const active = this.downloads.get(transferId)
    if (!active || active.generation !== generation) {
      throw new SyncFilesError('FILE_STALE_GENERATION', false)
    }
    return active
  }

  private isCurrentDownload(active: ActiveDownload): boolean {
    return this.downloads.get(active.transferId) === active
  }

  private deleteCurrentDownload(active: ActiveDownload): boolean {
    if (!this.isCurrentDownload(active)) {
      return false
    }
    this.downloads.delete(active.transferId)
    return true
  }

  private async cancelTransfer(
    identity: SyncTicketIdentity,
    transferId: string,
    generation: number,
    reason: string,
  ): Promise<void> {
    const active = this.downloads.get(transferId)
    if (active) {
      if (active.generation !== generation) {
        throw new SyncFilesError('FILE_STALE_GENERATION', false)
      }
      active.controller.abort(new Error(reason))
      this.downloads.delete(transferId)
    }
    await this.options.adapter.cancel({ identity, transferId, generation, reason })
  }

  private async withDeadline<T>(
    deadlineMs: number,
    operation: (signal: AbortSignal) => Promise<T>,
    parentSignal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController()
    let timedOut = false
    const abortFromParent = (): void => controller.abort(parentSignal?.reason)
    if (parentSignal?.aborted) {
      abortFromParent()
    } else {
      parentSignal?.addEventListener('abort', abortFromParent, { once: true })
    }
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort(new Error('file-transfer-deadline'))
    }, deadlineMs)
    timer.unref()
    const abortError = (): Error => {
      if (timedOut) {
        return new SyncFilesError('FILE_DEADLINE_EXCEEDED', true)
      }
      return controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new SyncFilesError('FILE_TRANSFER_CANCELLED', false)
    }
    let rejectAborted = (_error: Error): void => undefined
    const aborted = new Promise<T>((_resolve, reject) => {
      rejectAborted = reject
    })
    const onAbort = (): void => rejectAborted(abortError())
    controller.signal.addEventListener('abort', onAbort, { once: true })
    try {
      if (controller.signal.aborted) {
        throw abortError()
      }
      const running = operation(controller.signal).catch((error: unknown) => {
        if (controller.signal.aborted) {
          throw abortError()
        }
        throw error
      })
      return await Promise.race([running, aborted])
    } finally {
      clearTimeout(timer)
      controller.signal.removeEventListener('abort', onAbort)
      parentSignal?.removeEventListener('abort', abortFromParent)
    }
  }
}

export class SyncFilesError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code)
    this.name = 'SyncFilesError'
  }
}

const ADAPTER_ERROR_CODES = new Set([
  'OPERATION_UNAVAILABLE',
  'FILE_ACCESS_DENIED',
  'FILE_BACKEND_ERROR',
  'FILE_CHUNK_OUT_OF_ORDER',
  'FILE_DESTINATION_CONFLICT',
  'FILE_INCOMPLETE',
  'FILE_INTEGRITY_MISMATCH',
  'FILE_NOT_FOUND',
  'FILE_PATH_INVALID',
  'FILE_RANGE_INVALID',
  'FILE_RESOURCE_INVALID',
  'FILE_RESUME_EXPIRED',
  'FILE_RESUME_INVALID',
  'FILE_STALE_GENERATION',
  'FILE_TRANSFER_CAPACITY',
  'FILE_TRANSFER_NOT_FOUND',
  'FILE_TRUNCATED',
])

const RETRYABLE_ADAPTER_ERROR_CODES = new Set(['OPERATION_UNAVAILABLE', 'FILE_BACKEND_ERROR', 'FILE_TRANSFER_CAPACITY'])

function normalizeFilesError(error: unknown): SyncFilesError {
  if (error instanceof SyncFilesError) {
    return error
  }
  if (error instanceof Error && error.name === 'FileProtocolError' && 'code' in error) {
    return new SyncFilesError(String((error as { code: unknown }).code), false)
  }
  if (error instanceof Error && error.name === 'HomeServerSyncFilesAdapterError' && 'code' in error) {
    const code = String((error as { code: unknown }).code)
    if (ADAPTER_ERROR_CODES.has(code)) {
      return new SyncFilesError(code, RETRYABLE_ADAPTER_ERROR_CODES.has(code))
    }
  }
  return new SyncFilesError('FILE_BACKEND_ERROR', true)
}
