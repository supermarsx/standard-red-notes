import { type Page } from '@playwright/test'

/**
 * Helpers for moving a real file through the real client: the app's own upload
 * path (what dropping a file on a note does) and the app's own download call
 * (what opening a file does), with the socket file lane's OWN account of each
 * download kept beside the bytes.
 *
 * IN-PAGE SURFACE (verified against app source):
 *   - app.filesController.uploadNewFile(file, { showToast })   FilesController.ts
 *   - app.files.downloadFile(fileItem, onDecryptedBytes)       FileService.ts
 *   - app.syncTransportFileLane                                WebApplication.ts
 *       the tab's WebSocketSyncTransport, narrowed to `isFileLaneAvailable()` and
 *       `downloadFileOverSocket(request)`. FileService reaches the transport
 *       through a closure that looks the method up at call time, so wrapping it
 *       on the instance observes every download the app itself makes.
 */

export type UploadedFile = { uuid: string; name: string; size: number; sha256: string }

/** What the socket file lane did for one download, in its own words. */
export type LaneDownload = {
  /** The encrypted total the client asked the lane for. */
  declaredSize: number
  /** Encrypted bytes the lane handed to the decryptor. */
  deliveredBytes: number
  /** The transport's own verdict: completed, unavailable, aborted or failed. */
  outcome: string
  /** The transport's failure code, when it failed. */
  code: string | null
}

export type FileDownload = {
  /** The app's own error text, or null when it reported success. */
  error: string | null
  size: number
  sha256: string
  /** Where the app says the bytes came from: network, memcache or local. */
  sources: string[]
  /** One entry per time the app asked the socket lane for this file. */
  lane: LaneDownload[]
}

/** Whether this tab's socket has negotiated the file lane right now. */
export async function fileLaneNegotiated(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const app = (window as any).mainApplicationGroup?.primaryApplication
    return app?.syncTransportFileLane?.isFileLaneAvailable() === true
    /* eslint-enable @typescript-eslint/no-explicit-any */
  })
}

/**
 * Uploads `size` bytes through the app's own upload path and returns what was
 * stored. The bytes are a fixed function of `seed`, so a second browser needs
 * nothing but the digest to know whether it got them back.
 */
export async function uploadFile(page: Page, name: string, size: number, seed: number): Promise<UploadedFile> {
  return page.evaluate(
    async ({ name, size, seed }) => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const app = (window as any).mainApplicationGroup?.primaryApplication
      if (!app) throw new Error('app not available')

      // xorshift32: incompressible enough that a transport cannot get the length
      // right by accident, and reproducible.
      const bytes = new Uint8Array(size)
      let state = seed >>> 0 || 1
      for (let index = 0; index < size; index++) {
        state ^= state << 13
        state >>>= 0
        state ^= state >>> 17
        state ^= state << 5
        state >>>= 0
        bytes[index] = state & 0xff
      }
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
      const sha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')

      const uploaded = await app.filesController.uploadNewFile(
        new File([bytes], name, { type: 'application/octet-stream' }),
        { showToast: false },
      )
      if (!uploaded) throw new Error(`the app did not store "${name}"`)

      return { uuid: uploaded.uuid as string, name, size, sha256 }
      /* eslint-enable @typescript-eslint/no-explicit-any */
    },
    { name, size, seed },
  )
}

/**
 * Downloads a file through the app's own download call and reports the bytes it
 * produced TOGETHER WITH what the socket lane says it did for them.
 *
 * Both halves are needed. The app falls back to HTTP when the lane delivers
 * nothing, so "the right bytes arrived" is true of a lane that carried none of
 * them; and "the lane completed" alone says nothing about the bytes.
 */
export async function downloadFile(page: Page, uuid: string): Promise<FileDownload> {
  return page.evaluate(async (uuid) => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const app = (window as any).mainApplicationGroup?.primaryApplication
    if (!app) throw new Error('app not available')
    const file = app.items.findItem(uuid)
    if (!file) throw new Error(`file item ${uuid} is not in this session`)
    const transport = app.syncTransportFileLane
    if (!transport) throw new Error('this build exposes no socket file lane to observe')

    const lane: Array<{ declaredSize: number; deliveredBytes: number; outcome: string; code: string | null }> = []
    const original = transport.downloadFileOverSocket
    transport.downloadFileOverSocket = async function (this: unknown, request: any) {
      const call = { declaredSize: request.declaredSize as number, deliveredBytes: 0, outcome: 'pending', code: null }
      lane.push(call)
      const outcome = await original.call(this, {
        ...request,
        onBytes: async (bytes: Uint8Array) => {
          call.deliveredBytes += bytes.byteLength
          await request.onBytes(bytes)
        },
      })
      call.outcome = String(outcome?.outcome)
      call.code = typeof outcome?.code === 'string' ? outcome.code : null
      return outcome
    }

    const chunks: Uint8Array[] = []
    const sources = new Set<string>()
    let error: string | null = null
    try {
      const failure = await app.files.downloadFile(
        file,
        async (decrypted: Uint8Array, progress: { source: string }) => {
          chunks.push(decrypted.slice())
          sources.add(progress.source)
        },
      )
      if (failure) error = String(failure.text ?? failure.message ?? failure)
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown)
    } finally {
      // The instance never had its own copy: removing ours puts the prototype's back.
      delete transport.downloadFileOverSocket
    }

    const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
    const whole = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      whole.set(chunk, offset)
      offset += chunk.byteLength
    }
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', whole))

    return {
      error,
      size,
      sha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(''),
      sources: Array.from(sources),
      lane,
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }, uuid)
}
