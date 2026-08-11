# Sandbox runner security model

Sandbox note content is untrusted browser code. The editor sends only the note's
HTML, CSS, JavaScript, and console-capture flag to `/sandbox.html`; it never sends
application services, decrypted items, credentials, cookies, or storage values.

The runner never executes when a note is opened or edited. The user must press
Run, which snapshots the current document into a fresh one-shot frame. The
parent and runner independently reject snapshots whose HTML, CSS, and JavaScript
exceed 1 MiB in aggregate UTF-8 bytes. This prevents a large synced note from
forcing an unbounded structured clone or synchronous DOM/CSS parse. The note
remains editable when a run is rejected. The runner then uses three independent
browser boundaries:

- Both visible and hidden frames use `sandbox="allow-scripts"` without
  `allow-same-origin`, top-navigation, form, download, or popup capabilities.
- Docker, single-container, and LXC nginx configurations serve the exact
  `/sandbox.html` path with a dedicated response CSP. Its one fixed bootstrap is
  hash-pinned, connections and subframes are disabled, and the response-level
  `sandbox allow-scripts` directive preserves the opaque origin on direct loads.
- The runner also carries an equivalent meta CSP for Electron, development, and
  other static-file serving paths. Meta CSP cannot enforce `frame-ancestors` or
  `sandbox`; nginx owns those directives and the iframe attribute remains the
  primary opaque-origin boundary.
- User JavaScript runs in a dedicated blob Worker rather than the iframe's main
  thread. The frame terminates that Worker after completion or after a fixed
  two-second deadline, so non-yielding code such as `while (true) {}` cannot
  hang the note or application tab. The Worker disables its network and child
  worker entry points in addition to inheriting `connect-src 'none'` from the
  frame. HTML and CSS still render in the opaque preview frame; JavaScript is a
  DOM-less Worker program and cannot read or mutate the preview document.
- Stop destroys the active runner frame instead of merely terminating its
  Worker. This clears the rendered DOM and stylesheet as well, so persistent CSS
  animation or media work cannot survive a reset.

`unsafe-eval` and `worker-src blob:` are intentionally present only in that
exact-path CSP because the fixed bootstrap creates a local Worker and that
Worker evaluates JavaScript received as message data. They are not present in
the parent app policy. Each frame URL carries a fresh run nonce, accepts one
matching payload from its parent, and the parent delivers that nonce only once.
This matters because sandbox code may navigate its own frame: the resulting
second `load` must never send decrypted note source to the new document. The
parent accepts console messages only from the frame's exact `contentWindow`.
Console capture is availability-bounded on both sides of that boundary: the
runner truncates each serialized message to 16 KiB and emits at most 200 entries,
using the final slot for one deterministic drop notice. The parent independently
requires a string payload, reapplies the 16 KiB limit, retains at most 200
entries, and ignores the rest until the user clears the console or starts a new
run. User code can call `postMessage` directly, so the parent-side limits are the
authoritative memory bound rather than trusting the runner wrapper.

The runner is pre-cached with the offline app shell. Cached responses retain the
runner's CSP headers, so an offline frame uses the same restrictions.

## Maintenance invariants

- Never add `allow-same-origin`, `allow-top-navigation`, or `allow-popups` to the
  iframe.
- Never add `unsafe-inline` or `unsafe-eval` to the parent app's `script-src`.
- When the inline bootstrap changes, update its hash in all three nginx
  configurations. `scripts/validate-web-runtime-security.test.mjs` computes the
  byte-exact hash and fails on drift.
- Runtime app-shell hash substitution must target only
  the parent policy's unique `script-src 'self' 'wasm-unsafe-eval'` prefix. It
  must replace both the image placeholder and a prior-start hash without ever
  replacing the sandbox runner's fixed hash.
- Keep console message and retained-entry limits synchronized between the fixed
  runner and `SandboxDocument.ts`; both sides are intentional defenses.
- Keep the 1 MiB aggregate UTF-8 run limit and its fixed error message
  synchronized between the parent helpers and the fixed runner. Validate before
  `postMessage` in the parent and again before DOM assignment in the runner.

The isolation prevents sandbox code from reading application state, console
floods cannot grow parent React state without limit, and non-yielding execution
is terminated at the deadline. It does not make arbitrary code harmless: a
Worker can still allocate aggressively before the browser processes the
termination request, so users should run copied code only when they accept that
short-lived local availability risk. A rendered preview may also consume local
resources until the user presses Stop; Stop removes the complete frame.
