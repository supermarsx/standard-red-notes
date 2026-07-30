import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import type { FileHandle } from 'fs/promises'
import { downloadData } from './FileNetworking'

type DownloadResult = 'success' | 'failed'

type ContentRange = {
  start: number
  end: number
  total: number
}

function parseContentRange(value: unknown): ContentRange | undefined {
  if (typeof value !== 'string') {
    return undefined
  }

  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(value.trim())
  if (!match) {
    return undefined
  }

  const start = Number(match[1])
  const end = Number(match[2])
  const total = Number(match[3])
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(total) ||
    start < 0 ||
    end < start ||
    total <= 0 ||
    end >= total
  ) {
    return undefined
  }

  return { start, end, total }
}

export class FileDownloader {
  constructor(
    private chunkSizes: number[],
    private valetToken: string,
    private url: string,
    private filePath: string,
  ) {}

  public async run(): Promise<DownloadResult> {
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.partial`
    let fileHandle: FileHandle | undefined

    try {
      fileHandle = await fs.open(temporaryPath, 'wx')
      const result = await this.downloadChunks(fileHandle)

      await fileHandle.close()
      fileHandle = undefined

      if (result !== 'success') {
        return result
      }

      /**
       * Publish only a fully downloaded and range-validated file. Writing into
       * a fresh sibling first means retries never append to an old/partial
       * backup and a failed retry cannot destroy a previously complete file.
       */
      await fs.rename(temporaryPath, this.filePath)
      return 'success'
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('Failed to download encrypted file backup', message)
      return 'failed'
    } finally {
      await fileHandle?.close().catch(() => undefined)
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }

  private async downloadChunks(fileHandle: FileHandle): Promise<DownloadResult> {
    let expectedRangeStart = 0
    let expectedTotal: number | undefined

    for (const pullChunkSize of this.chunkSizes) {
      if (!Number.isSafeInteger(pullChunkSize) || pullChunkSize <= 0) {
        return 'failed'
      }

      const headers = {
        'x-valet-token': this.valetToken,
        'x-chunk-size': pullChunkSize.toString(),
        range: `bytes=${expectedRangeStart}-`,
      }

      const response = await downloadData(this.url, headers, pullChunkSize)

      if (response.status !== 206) {
        return 'failed'
      }

      const range = parseContentRange(response.headers['content-range'])
      if (
        !range ||
        range.start !== expectedRangeStart ||
        (expectedTotal !== undefined && range.total !== expectedTotal) ||
        response.data.byteLength !== range.end - range.start + 1 ||
        response.data.byteLength > pullChunkSize
      ) {
        return 'failed'
      }

      expectedTotal = range.total
      await fileHandle.writeFile(response.data)

      if (range.end === range.total - 1) {
        return 'success'
      }

      expectedRangeStart = range.end + 1
    }

    return 'failed'
  }
}
