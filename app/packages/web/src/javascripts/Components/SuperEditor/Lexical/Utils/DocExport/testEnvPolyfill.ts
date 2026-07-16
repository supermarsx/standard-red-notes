/**
 * TEST-ONLY environment shim. Do NOT import from product code — only specs.
 *
 * The DOCX (`docx`) and ODT (`@zip.js/zip.js`) generators rely on WHATWG globals
 * that exist in every real browser but that jest's jsdom environment omits:
 * `TextEncoder`/`TextDecoder`, the WHATWG stream classes, a `Blob` whose
 * `arrayBuffer()` actually works, and a `Response` that can drain a
 * `ReadableStream` (zip.js reads its writer's stream via `new Response(stream).blob()`).
 *
 * `installExportTestEnv()` fills those gaps from Node's own implementations. It is
 * idempotent and must be called at the TOP of a spec file, before any dynamic
 * `import('docx')` / `import('@zip.js/zip.js')`.
 *
 * NOTE: we deliberately do not pull in `undici` for `Response` — undici drags in
 * `MessagePort`/`MessageChannel` and other globals jsdom lacks. A tiny stream-
 * draining shim is enough for zip.js and keeps the test env minimal.
 */
import { Blob as NodeBlob } from 'node:buffer'
import * as nodeStreamWeb from 'node:stream/web'
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from 'node:util'

type AnyRecord = Record<string, unknown>

const toBytes = async (chunk: unknown): Promise<Uint8Array> => {
  if (chunk instanceof Uint8Array) {
    return chunk
  }
  if (typeof chunk === 'string') {
    return new TextEncoder().encode(chunk)
  }
  if (chunk instanceof ArrayBuffer) {
    return new Uint8Array(chunk)
  }
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  }
  // A Blob-like with arrayBuffer()
  const maybeBlob = chunk as { arrayBuffer?: () => Promise<ArrayBuffer> }
  if (maybeBlob && typeof maybeBlob.arrayBuffer === 'function') {
    return new Uint8Array(await maybeBlob.arrayBuffer())
  }
  throw new Error('Response shim: unsupported body chunk type')
}

const drain = async (body: unknown): Promise<Uint8Array[]> => {
  const stream = body as { getReader?: () => { read: () => Promise<{ value: unknown; done: boolean }> } }
  if (stream && typeof stream.getReader === 'function') {
    const reader = stream.getReader()
    const chunks: Uint8Array[] = []
    for (;;) {
      const { value, done } = await reader.read()
      if (done) {
        break
      }
      if (value != null) {
        chunks.push(await toBytes(value))
      }
    }
    return chunks
  }
  return [await toBytes(body)]
}

const concat = (chunks: Uint8Array[]): Uint8Array => {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

let installed = false

export const installExportTestEnv = (): void => {
  if (installed) {
    return
  }
  installed = true

  const g = globalThis as unknown as AnyRecord

  g.TextEncoder = g.TextEncoder ?? NodeTextEncoder
  g.TextDecoder = g.TextDecoder ?? NodeTextDecoder

  for (const key of [
    'ReadableStream',
    'WritableStream',
    'TransformStream',
    'CompressionStream',
    'DecompressionStream',
  ]) {
    const value = (nodeStreamWeb as AnyRecord)[key]
    if (g[key] == null && value != null) {
      g[key] = value
    }
  }

  // Node's Blob has a working arrayBuffer(); jsdom's does not.
  g.Blob = NodeBlob

  // Minimal Response: enough for zip.js `new Response(stream).blob()/.arrayBuffer()`.
  g.Response = class ResponseShim {
    private readonly body: unknown
    constructor(body?: unknown) {
      this.body = body
    }
    async arrayBuffer(): Promise<ArrayBuffer> {
      const bytes = concat(await drain(this.body))
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    }
    async blob(): Promise<Blob> {
      const chunks = await drain(this.body)
      return new NodeBlob(chunks)
    }
    async text(): Promise<string> {
      return new TextDecoder().decode(concat(await drain(this.body)))
    }
  }
}

/** Read a Blob's bytes in the test env (works with the Node Blob installed above). */
export const blobToBytes = async (blob: Blob): Promise<Uint8Array> => {
  return new Uint8Array(await blob.arrayBuffer())
}
