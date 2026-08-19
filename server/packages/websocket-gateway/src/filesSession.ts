import { createHash } from 'node:crypto'

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
  cancel(
    input: { identity: SyncTicketIdentity; transferId: string; generation: number; reason: string },
  ): Promise<void>
}

export interface SyncFilesSessionMetrics {
  increment(event: string, code?: string): void
}

export type SyncFilesSessionOptions = {
  adapter: SyncFilesAdapter
  sendControl: (
    type: SyncServerFrameType,
    requestId: string,
    commandId: string,
    payload: JsonObject,
  ) => boolean
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
            controller: new AbortController(),
            digest: createHash('sha256'),
            pumping: false,
          }
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
          active.creditBytes = Math.min(
            MAX_FILE_TRANSFER_CREDIT_BYTES,
            active.creditBytes + frame.payload.creditBytes,
          )
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
        const chunk = await this.options.adapter.readDownloadChunk(
          {
            identity: active.identity,
            transferId: active.transferId,
            generation: active.generation,
            index: active.nextIndex,
            offset: active.nextOffset,
            maxBytes,
          },
          active.controller.signal,
        )
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
          this.downloads.delete(active.transferId)
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
      this.downloads.delete(active.transferId)
      active.controller.abort(error)
      await this.options.adapter
        .cancel({
          identity: active.identity,
          transferId: active.transferId,
          generation: active.generation,
          reason: 'download-failed',
        })
        .catch(() => undefined)
      const normalized = normalizeFilesError(error)
      this.options.sendError(active.requestId, active.commandId, normalized.code)
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

  private async withDeadline<T>(deadlineMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('file-transfer-deadline')), deadlineMs)
    timer.unref()
    try {
      return await Promise.race([
        operation(controller.signal),
        new Promise<T>((_resolve, reject) => {
          controller.signal.addEventListener(
            'abort',
            () => reject(new SyncFilesError('FILE_DEADLINE_EXCEEDED', true)),
            { once: true },
          )
        }),
      ])
    } finally {
      clearTimeout(timer)
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

function normalizeFilesError(error: unknown): SyncFilesError {
  if (error instanceof SyncFilesError) {
    return error
  }
  if (error instanceof Error && error.name === 'FileProtocolError' && 'code' in error) {
    return new SyncFilesError(String((error as { code: unknown }).code), false)
  }
  return new SyncFilesError('FILE_BACKEND_ERROR', true)
}
