import type { AxiosInstance, AxiosResponse } from 'axios'

import {
  MultiContainerSyncFilesAdapterError,
  type MultiContainerFileRangeResult,
  type MultiContainerFileStoragePort,
  type MultiContainerFileStorageTarget,
} from './MultiContainerSyncFilesAdapter'

export type HttpFilesServiceStorageOptions = {
  /**
   * INTERNAL base URL of the files service (e.g. `http://files:3000`). This is
   * deliberately not the public files URL: these calls never leave the cluster.
   */
  filesServerUrl: string
  httpClient: Pick<AxiosInstance, 'request'>
  requestTimeoutMs?: number
  isReady?: () => boolean
}

const PERSONAL_BASE_PATH = '/v1/files'
const SHARED_VAULT_BASE_PATH = '/v1/shared-vault/files'
const MAX_CHUNK_BYTES = 256 * 1024
const MAX_RESPONSE_BYTES = MAX_CHUNK_BYTES + 64 * 1024
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const CONTENT_RANGE_PATTERN = /^bytes (?:(\d+)-(\d+)|\*)\/(\d+)$/u

/**
 * The distributed storage boundary: the files service reached over HTTP with a
 * single-use valet credential.
 *
 * Every request carries the credential in the `x-valet-token` header (never a
 * query string — URLs are retained by access logs, proxies and tracing). The
 * owner namespace is NOT sent: the files service derives it from the signed
 * token, so this process cannot widen its own reach by asserting a different
 * owner.
 */
export class HttpFilesServiceStorage implements MultiContainerFileStoragePort {
  private readonly baseUrl: string
  private readonly requestTimeoutMs: number

  constructor(private readonly options: HttpFilesServiceStorageOptions) {
    if (!options.filesServerUrl) {
      throw new Error('An internal files service URL is required to serve FILES_V1.')
    }
    this.baseUrl = options.filesServerUrl.replace(/\/+$/u, '')
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1_000) {
      throw new Error('requestTimeoutMs must be at least 1000ms.')
    }
  }

  ready(): boolean {
    return this.baseUrl.length > 0 && (this.options.isReady?.() ?? true)
  }

  async probeSize(target: MultiContainerFileStorageTarget, signal: AbortSignal): Promise<number | undefined> {
    const response = await this.request(
      {
        method: 'GET',
        url: `${this.url(target)}/`,
        headers: {
          ...this.credentialHeaders(target),
          range: 'bytes=0-0',
          'x-chunk-size': '1',
        },
        responseType: 'arraybuffer',
      },
      signal,
    )
    if (response.status === 404) {
      return undefined
    }
    if (response.status === 416) {
      // The resource exists but holds no satisfiable byte at offset 0.
      return this.totalSizeFromContentRange(response) ?? 0
    }
    this.assertSuccessful(response)
    const totalSize = this.totalSizeFromContentRange(response)
    if (totalSize === undefined) {
      throw new MultiContainerSyncFilesAdapterError('FILE_BACKEND_ERROR')
    }
    return totalSize
  }

  async createUploadSession(target: MultiContainerFileStorageTarget, signal: AbortSignal): Promise<void> {
    const response = await this.request(
      {
        method: 'POST',
        url: `${this.url(target)}/upload/create-session`,
        headers: { ...this.credentialHeaders(target), 'content-type': 'application/json' },
        data: {},
      },
      signal,
    )
    this.assertSuccessful(response)
    this.assertReportedSuccess(response)
  }

  async uploadPart(
    input: { target: MultiContainerFileStorageTarget; partNumber: number; bytes: Uint8Array },
    signal: AbortSignal,
  ): Promise<void> {
    if (!Number.isSafeInteger(input.partNumber) || input.partNumber < 1) {
      throw new MultiContainerSyncFilesAdapterError('FILE_BACKEND_ERROR')
    }
    if (input.bytes.byteLength < 1) {
      throw new MultiContainerSyncFilesAdapterError('FILE_BACKEND_ERROR')
    }
    const response = await this.request(
      {
        method: 'POST',
        url: `${this.url(input.target)}/upload/chunk`,
        headers: {
          ...this.credentialHeaders(input.target),
          'content-type': 'application/octet-stream',
          'x-chunk-id': String(input.partNumber),
        },
        data: Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength),
      },
      signal,
    )
    this.assertSuccessful(response)
    this.assertReportedSuccess(response)
  }

  async closeUploadSession(target: MultiContainerFileStorageTarget, signal: AbortSignal): Promise<void> {
    const response = await this.request(
      {
        method: 'POST',
        url: `${this.url(target)}/upload/close-session`,
        headers: { ...this.credentialHeaders(target), 'content-type': 'application/json' },
        data: {},
      },
      signal,
    )
    this.assertSuccessful(response)
    this.assertReportedSuccess(response)
  }

  async readRange(
    input: { target: MultiContainerFileStorageTarget; offset: number; length: number },
    signal: AbortSignal,
  ): Promise<MultiContainerFileRangeResult> {
    if (
      !Number.isSafeInteger(input.offset) ||
      input.offset < 0 ||
      !Number.isSafeInteger(input.length) ||
      input.length < 1 ||
      input.length > MAX_CHUNK_BYTES
    ) {
      throw new MultiContainerSyncFilesAdapterError('FILE_RANGE_INVALID')
    }
    const response = await this.request(
      {
        method: 'GET',
        url: `${this.url(input.target)}/`,
        headers: {
          ...this.credentialHeaders(input.target),
          range: `bytes=${input.offset}-${input.offset + input.length - 1}`,
          'x-chunk-size': String(input.length),
        },
        responseType: 'arraybuffer',
      },
      signal,
    )
    if (response.status === 404) {
      throw new MultiContainerSyncFilesAdapterError('FILE_NOT_FOUND')
    }
    if (response.status === 416) {
      throw new MultiContainerSyncFilesAdapterError('FILE_RANGE_INVALID')
    }
    this.assertSuccessful(response)
    const totalSize = this.totalSizeFromContentRange(response)
    const bytes = toBytes(response.data)
    if (totalSize === undefined || bytes === undefined) {
      throw new MultiContainerSyncFilesAdapterError('FILE_BACKEND_ERROR')
    }
    if (bytes.byteLength > input.length) {
      bytes.fill(0)
      throw new MultiContainerSyncFilesAdapterError('FILE_BACKEND_ERROR')
    }
    return { bytes, totalSize }
  }

  private url(target: MultiContainerFileStorageTarget): string {
    return `${this.baseUrl}${target.ownershipType === 'shared-vault' ? SHARED_VAULT_BASE_PATH : PERSONAL_BASE_PATH}`
  }

  private credentialHeaders(target: MultiContainerFileStorageTarget): Record<string, string> {
    return { 'x-valet-token': target.valetToken }
  }

  private async request(
    config: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<AxiosResponse<unknown, unknown>> {
    signal.throwIfAborted()
    try {
      return await this.options.httpClient.request({
        ...config,
        signal,
        timeout: this.requestTimeoutMs,
        maxContentLength: MAX_RESPONSE_BYTES,
        maxBodyLength: Infinity,
        // Statuses are classified below; only transport failures throw here.
        validateStatus: () => true,
      })
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof MultiContainerSyncFilesAdapterError) {
        throw error
      }
      throw new MultiContainerSyncFilesAdapterError('FILE_BACKEND_ERROR')
    }
  }

  private assertSuccessful(response: AxiosResponse<unknown, unknown>): void {
    if (response.status >= 200 && response.status < 300) {
      return
    }
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new MultiContainerSyncFilesAdapterError('FILE_ACCESS_DENIED')
    }
    if (response.status === 404) {
      throw new MultiContainerSyncFilesAdapterError('FILE_NOT_FOUND')
    }
    if (response.status === 416) {
      throw new MultiContainerSyncFilesAdapterError('FILE_RANGE_INVALID')
    }
    if (response.status === 413) {
      throw new MultiContainerSyncFilesAdapterError('FILE_RESOURCE_INVALID')
    }
    throw new MultiContainerSyncFilesAdapterError('FILE_BACKEND_ERROR')
  }

  private assertReportedSuccess(response: AxiosResponse<unknown, unknown>): void {
    const body = response.data
    if (
      typeof body !== 'object' ||
      body === null ||
      Array.isArray(body) ||
      (body as { success?: unknown }).success !== true
    ) {
      throw new MultiContainerSyncFilesAdapterError('FILE_BACKEND_ERROR')
    }
  }

  private totalSizeFromContentRange(response: AxiosResponse<unknown, unknown>): number | undefined {
    const headers = response.headers as unknown as Record<string, unknown> | undefined
    const raw = headers?.['content-range'] ?? headers?.['Content-Range']
    const value = Array.isArray(raw) ? raw[0] : raw
    if (typeof value !== 'string') {
      return undefined
    }
    const match = CONTENT_RANGE_PATTERN.exec(value.trim())
    if (!match) {
      return undefined
    }
    const total = Number(match[3])
    return Number.isSafeInteger(total) && total >= 0 ? total : undefined
  }
}

function toBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof Uint8Array) {
    return new Uint8Array(data)
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data.slice(0))
  }
  return undefined
}
