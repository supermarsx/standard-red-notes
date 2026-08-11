/**
 * Sandbox note document model (JS Sandbox / Web App Sandbox).
 *
 * A Sandbox note stores three code panes — HTML, CSS, and JS — plus a small bit
 * of editor UI state (the active pane). Two editor identifiers share this model
 * and this component; they differ only in presentation mode:
 *   - JS Sandbox (jsfiddle-like): JS-focused with a captured console output panel.
 *   - Web App Sandbox (codepen-like): a live rendered preview of html/css/js.
 *
 * Exactly like the Canvas and Base note types, the serialized document is stored
 * verbatim in `note.text` (the same slot Super stores its Lexical JSON). This
 * keeps a Sandbox note round-tripping and syncing like any other note with no
 * models/snjs changes — the note is marked as a sandbox purely via
 * `note.editorIdentifier`.
 */

export const SANDBOX_DOCUMENT_VERSION = 1

export type SandboxPane = 'html' | 'css' | 'js'

export type SandboxDocument = {
  version: number
  html: string
  css: string
  js: string
  /** Which code pane the editor had focused last (UI convenience only). */
  activePane: SandboxPane
}

export const createEmptySandboxDocument = (): SandboxDocument => ({
  version: SANDBOX_DOCUMENT_VERSION,
  html: '',
  css: '',
  js: '',
  activePane: 'html',
})

/** Tiny starter template for a fresh Web App Sandbox. */
export const createWebSandboxStarter = (): SandboxDocument => ({
  version: SANDBOX_DOCUMENT_VERSION,
  html: '<h1>Hello, sandbox</h1>\n<p>Edit the HTML, CSS, and JS panes.</p>',
  css: 'body {\n  font-family: sans-serif;\n  padding: 1rem;\n}',
  js: "console.log('Web App Sandbox ready')",
  activePane: 'html',
})

/** Tiny starter template for a fresh JS Sandbox. */
export const createJsSandboxStarter = (): SandboxDocument => ({
  version: SANDBOX_DOCUMENT_VERSION,
  html: '',
  css: '',
  js: "// Write JavaScript and press Run.\nconsole.log('Hello from the JS Sandbox')\n\nfor (let i = 1; i <= 3; i++) {\n  console.log('count', i)\n}",
  activePane: 'js',
})

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const isString = (value: unknown): value is string => typeof value === 'string'

const isValidPane = (value: unknown): value is SandboxPane => value === 'html' || value === 'css' || value === 'js'

/**
 * Parse note text into a SandboxDocument. Never throws: empty, legacy plain
 * text, or otherwise malformed JSON all fall back to a blank sandbox. The second
 * return value reports whether the input was recoverable sandbox JSON so the
 * editor can surface a non-destructive notice when content was discarded.
 */
export const parseSandboxDocument = (
  text: string | undefined | null,
): { document: SandboxDocument; recovered: boolean } => {
  if (!text || text.trim().length === 0) {
    return { document: createEmptySandboxDocument(), recovered: true }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { document: createEmptySandboxDocument(), recovered: false }
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { document: createEmptySandboxDocument(), recovered: false }
  }

  const candidate = parsed as Record<string, unknown>

  // A sandbox document exposes at least one of the code panes; otherwise it is
  // probably some other note format being switched into a sandbox, so treat it
  // as a fresh blank sandbox but flag it as not-recovered.
  const looksLikeSandbox = isString(candidate.html) || isString(candidate.css) || isString(candidate.js)

  if (!looksLikeSandbox) {
    return { document: createEmptySandboxDocument(), recovered: false }
  }

  return {
    document: {
      version: isFiniteNumber(candidate.version) ? candidate.version : SANDBOX_DOCUMENT_VERSION,
      html: isString(candidate.html) ? candidate.html : '',
      css: isString(candidate.css) ? candidate.css : '',
      js: isString(candidate.js) ? candidate.js : '',
      activePane: isValidPane(candidate.activePane) ? candidate.activePane : 'html',
    },
    recovered: true,
  }
}

/** Serialize a SandboxDocument to the string stored in `note.text`. */
export const serializeSandboxDocument = (document: SandboxDocument): string => {
  return JSON.stringify({
    version: document.version ?? SANDBOX_DOCUMENT_VERSION,
    html: document.html ?? '',
    css: document.css ?? '',
    js: document.js ?? '',
    activePane: document.activePane ?? 'html',
  })
}

export const SANDBOX_CONSOLE_CHANNEL = '__SN_SANDBOX_CONSOLE__'
export const SANDBOX_RUN_CHANNEL = '__SN_SANDBOX_RUN__'

/**
 * Console output crosses an untrusted iframe boundary. Keep both dimensions
 * bounded so noisy sandbox code cannot grow the parent application's React
 * state without limit. The fixed runner applies the same limits before
 * postMessage; this normalizer is the parent's defensive boundary.
 */
export const SANDBOX_CONSOLE_MAX_MESSAGE_LENGTH = 16_384
export const SANDBOX_CONSOLE_MAX_ENTRIES = 200
export const SANDBOX_CONSOLE_TRUNCATION_SUFFIX = '\n... [truncated]'
export const SANDBOX_CONSOLE_LIMIT_NOTICE = 'Console output limit reached; further messages were dropped.'

export type SandboxConsoleLevel = 'log' | 'info' | 'warn' | 'error'

export type SandboxConsoleEntryContent = {
  level: SandboxConsoleLevel
  message: string
}

/**
 * Validate and bound one console event before retaining it in parent state.
 * The final slot is reserved for a deterministic notice, after which callers
 * must ignore output until the console is explicitly cleared or run again.
 */
export const normalizeSandboxConsoleEntry = (
  data: { level?: unknown; message?: unknown },
  acceptedCount: number,
): SandboxConsoleEntryContent | undefined => {
  if (acceptedCount >= SANDBOX_CONSOLE_MAX_ENTRIES || typeof data.message !== 'string') {
    return undefined
  }

  if (acceptedCount === SANDBOX_CONSOLE_MAX_ENTRIES - 1) {
    return { level: 'warn', message: SANDBOX_CONSOLE_LIMIT_NOTICE }
  }

  const level: SandboxConsoleLevel =
    data.level === 'warn' || data.level === 'error' || data.level === 'info' ? data.level : 'log'
  const message =
    data.message.length > SANDBOX_CONSOLE_MAX_MESSAGE_LENGTH
      ? `${data.message.slice(
          0,
          SANDBOX_CONSOLE_MAX_MESSAGE_LENGTH - SANDBOX_CONSOLE_TRUNCATION_SUFFIX.length,
        )}${SANDBOX_CONSOLE_TRUNCATION_SUFFIX}`
      : data.message

  return { level, message }
}

/**
 * A fresh, per-frame token binds one payload to one `/sandbox.html` document.
 * The iframe remains opaque-origin, so this is not an authentication secret;
 * it prevents a later self-navigation from accepting a stale run message.
 */
export const createSandboxRunNonce = (): string => {
  const bytes = new Uint8Array(16)
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
}

/** Claim delivery once for a nonce. A navigated iframe fires `load` again. */
export const claimSandboxRunDelivery = (state: { current: string | undefined }, nonce: string): boolean => {
  if (state.current === nonce) {
    return false
  }
  state.current = nonce
  return true
}

export type SandboxRunPayload = {
  channel: typeof SANDBOX_RUN_CHANNEL
  nonce: string
  document: Pick<SandboxDocument, 'html' | 'css' | 'js'>
  captureConsole: boolean
}

/**
 * Build the message sent to the fixed, hash-pinned `/sandbox.html` runner.
 * User-controlled code is data in this message; it is never serialized into an
 * inline script in the application document. The runner is also rendered with
 * `sandbox="allow-scripts"` WITHOUT `allow-same-origin`, so its code cannot reach
 * the parent app, its cookies, or storage.
 */
export const buildSandboxRunPayload = (
  document: Pick<SandboxDocument, 'html' | 'css' | 'js'>,
  options: { captureConsole: boolean; nonce: string },
): SandboxRunPayload => ({
  channel: SANDBOX_RUN_CHANNEL,
  nonce: options.nonce,
  document: {
    html: document.html ?? '',
    css: document.css ?? '',
    js: document.js ?? '',
  },
  captureConsole: options.captureConsole,
})
