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

const isValidPane = (value: unknown): value is SandboxPane =>
  value === 'html' || value === 'css' || value === 'js'

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
  const looksLikeSandbox =
    isString(candidate.html) || isString(candidate.css) || isString(candidate.js)

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

/**
 * Prelude injected into the sandbox iframe `srcdoc`. It wraps `console.*` and
 * `window.onerror` / unhandled rejections and forwards each message to the
 * parent via `postMessage`. Sent as the iframe's first script so it captures
 * output from the user's code that follows. The `__SN_SANDBOX_CONSOLE__` channel
 * marker lets the parent distinguish these messages from any other postMessage
 * traffic. postMessage works from a `sandbox="allow-scripts"` iframe (without
 * `allow-same-origin`) — the parent validates `event.source` is this iframe.
 */
export const SANDBOX_CONSOLE_CHANNEL = '__SN_SANDBOX_CONSOLE__'

const buildConsolePrelude = (): string => `<script>(function(){
  var channel = ${JSON.stringify(SANDBOX_CONSOLE_CHANNEL)};
  function send(level, args){
    try {
      var parts = [];
      for (var i = 0; i < args.length; i++) {
        var a = args[i];
        if (typeof a === 'string') { parts.push(a); }
        else {
          try { parts.push(JSON.stringify(a)); }
          catch (e) { parts.push(String(a)); }
        }
      }
      parent.postMessage({ channel: channel, level: level, message: parts.join(' ') }, '*');
    } catch (e) {}
  }
  var methods = ['log', 'info', 'warn', 'error', 'debug'];
  for (var m = 0; m < methods.length; m++) {
    (function(method){
      var original = console[method];
      console[method] = function(){
        send(method === 'debug' ? 'log' : method, arguments);
        if (original) { try { original.apply(console, arguments); } catch (e) {} }
      };
    })(methods[m]);
  }
  window.addEventListener('error', function(event){
    send('error', [event.message + (event.filename ? ' (' + event.lineno + ':' + event.colno + ')' : '')]);
  });
  window.addEventListener('unhandledrejection', function(event){
    var reason = event.reason;
    send('error', ['Unhandled rejection: ' + (reason && reason.message ? reason.message : String(reason))]);
  });
})();</script>`

/**
 * Build the iframe `srcdoc` from the document. Composes
 * `<style>{css}</style>{html}<script>{js}</script>` inside a minimal HTML
 * shell. When `captureConsole` is true the console-capturing prelude is injected
 * as the first script so it wraps `console.*` before the user's JS runs. The
 * iframe is rendered with `sandbox="allow-scripts"` WITHOUT `allow-same-origin`,
 * so the contained code cannot reach the parent app, its cookies, or storage.
 */
export const buildSandboxSrcdoc = (
  document: Pick<SandboxDocument, 'html' | 'css' | 'js'>,
  options: { captureConsole: boolean },
): string => {
  const css = document.css ?? ''
  const html = document.html ?? ''
  const js = document.js ?? ''
  const prelude = options.captureConsole ? buildConsolePrelude() : ''
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<style>${css}</style>
${prelude}
</head>
<body>
${html}
<script>${js}</script>
</body>
</html>`
}
