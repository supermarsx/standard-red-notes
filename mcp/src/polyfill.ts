// snjs and @standardnotes/sncrypto-web are built for the browser and reference
// a few browser globals at module-load time (`self`, occasionally `window`).
// Import this module FIRST (before any @standardnotes/* import) so those
// globals exist when their bundles evaluate. Node 22 already provides global
// `crypto` (WebCrypto), `fetch`, and `WebSocket`, so only `self`/`window` need
// shimming for headless use.

const g = globalThis as unknown as Record<string, unknown>

if (g.self === undefined) {
  g.self = globalThis
}
if (g.window === undefined) {
  g.window = globalThis
}
// snjs probes `document.documentMode` and `navigator.userAgent` when detecting
// WebCrypto support. A minimal stub is enough; we never touch the DOM.
if (g.document === undefined) {
  g.document = {}
}
if (g.navigator === undefined) {
  g.navigator = { userAgent: 'node' }
}

export {}
