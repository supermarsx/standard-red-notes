/**
 * Which Lexical node types may be MOUNTED on a public share page, and what the
 * reader is shown in place of one that may not.
 *
 *
 * WHY A PRE-PARSE REDACTION RATHER THAN A RUNTIME GUARD
 *
 * Two different hazards, both of which have to be handled before anything is
 * rendered:
 *
 *  1. A node whose component calls `useApplication()` (or `usePreference()`)
 *     THROWS without an `<ApplicationProvider>`, which the public page does not
 *     have. Lexical catches that in the decorator boundary, so the block does
 *     not take the page down — but the reader gets a generic "could not be
 *     displayed" box that says nothing about what is missing.
 *
 *  2. A node that renders a remote `<iframe>` or `<img>` works PERFECTLY on a
 *     public page, and that is the problem: it fetches on the reader's behalf
 *     the instant it is inserted, handing a third party the reader's IP address
 *     and the fact that they opened this link. A `MutationObserver` cannot
 *     close this — the observer callback is a microtask, and the fetch starts
 *     when the element enters the document.
 *
 * So the serialized state is rewritten BEFORE `parseEditorState` ever sees it.
 * A redacted node is never constructed, never decorated, and never mounted, so
 * there is no request to intercept and no component to catch.
 *
 *
 * WHY A DENYLIST IS ACCEPTABLE HERE, GIVEN THAT A DENYLIST CANNOT HOLD A TRUST
 * BOUNDARY
 *
 * Because the denylist is not the gate — `SharedNodePolicy.spec.ts` is. That
 * spec enumerates every type in the registered node set (`AllNodes`), walks each
 * node module's own import graph for an application hook, and FAILS when a
 * registered type is neither classified here nor provably safe. A new node
 * cannot be added to the editor and quietly reach a public page: the gate goes
 * red naming the type. The failure mode of getting this wrong is also the
 * better direction — a safe node wrongly listed shows a visible placeholder
 * (annoying, honest), rather than a beacon that nobody sees.
 */

/** Why one node type is not mounted on a public page. */
export type ShareBlockedReason =
  /** Its component needs a WebApplication, which a public page does not have. */
  | 'needs-application'
  /** It fetches from a third party as soon as it is on screen. */
  | 'remote-subresource'

export type ShareBlockedNode = {
  reason: ShareBlockedReason
  /** What the reader sees instead. Names the construct, never the internals. */
  message: string
}

export const SHARE_BLOCKED_NODE_TYPES: Record<string, ShareBlockedNode> = {
  // --- 1. needs an application -------------------------------------------
  // `shareAssets` replaces every `snfile` with a self-contained `shared-image`
  // at share-creation time, so a link created now carries none of these. A link
  // created before that work still can, and its bytes were never reachable from
  // a public page anyway (both the files read and the valet-token mint answer
  // 401 with no session).
  snfile: {
    reason: 'needs-application',
    message: '[This note has an attached file. A share link cannot carry it, so it is not included here.]',
  },
  'inline-file': {
    reason: 'needs-application',
    message: '[This note has an embedded file. A share link cannot carry it, so it is not included here.]',
  },
  // A remote image is BOTH: its component needs an application, and the `<img>`
  // it would render points at a third-party host.
  'unencrypted-image': {
    reason: 'remote-subresource',
    message: '[This note embeds an image from another website. It is not loaded on a shared link.]',
  },
  snbubble: {
    reason: 'needs-application',
    message: '[This note links to another item in the author’s account, which is not part of this share link.]',
  },
  'clock-widget': {
    reason: 'needs-application',
    message: '[A clock was here. It is not shown on a shared link.]',
  },

  // --- 2. fetches from a third party as soon as it renders ----------------
  // Each of these mounts an iframe pointing at an external origin with no
  // interaction at all, so merely opening the link would tell that origin who
  // the reader is. The editor is a signed-in surface where that is the user's
  // own choice; a public link is not.
  //
  // Deliberately NOT listed, and each checked: `web-embed` is click-to-load and
  // its control is inert here; `sql-query` loads its WASM only from the Run
  // button, which is inert here; `tweet` and `tweet-embed` render a link, never
  // a script; `qr-code` rasterizes a local blob URL; `shipment-tracking`
  // renders a link.
  youtube: {
    reason: 'remote-subresource',
    message: '[This note embeds a YouTube video. It is not loaded on a shared link — open the note to watch it.]',
  },
  embed: {
    reason: 'remote-subresource',
    message: '[This note embeds a page from another website. It is not loaded on a shared link.]',
  },
  tradingview: {
    reason: 'remote-subresource',
    message: '[This note embeds a live market chart from another website. It is not loaded on a shared link.]',
  },
  'stock-chart': {
    reason: 'remote-subresource',
    message: '[This note embeds a live stock chart from another website. It is not loaded on a shared link.]',
  },
}

/** Lexical's `IS_ITALIC` text-format bit, so a placeholder reads as an aside. */
const LEXICAL_FORMAT_ITALIC = 2

export type ShareRedaction = { type: string; reason: ShareBlockedReason }

export type RedactShareNodesResult = {
  /** The serialized state to parse. Unchanged when nothing was redacted. */
  text: string
  redacted: ShareRedaction[]
}

type SerializedNode = { type?: unknown; format?: unknown }

const placeholderFor = (blocked: ShareBlockedNode, format: unknown) => ({
  children: [
    {
      detail: 0,
      format: LEXICAL_FORMAT_ITALIC,
      mode: 'normal',
      style: '',
      text: blocked.message,
      type: 'text',
      version: 1,
    },
  ],
  direction: 'ltr',
  format: typeof format === 'string' ? format : '',
  indent: 0,
  type: 'paragraph',
  version: 1,
  textFormat: 0,
  textStyle: '',
})

/**
 * Replace every blocked node in a serialized Super state with a visible
 * placeholder paragraph.
 *
 * Returns the ORIGINAL string untouched when nothing matched, so a note with no
 * blocked nodes is not re-serialized (and cannot be perturbed by a round trip
 * through `JSON.parse`/`stringify`).
 */
export function redactShareNodes(text: string): RedactShareNodesResult {
  if (text.length === 0) {
    return { text, redacted: [] }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // Not a serialized state. Nothing to redact; the caller decides what this
    // text is (see `resolveSharedNoteFormat`).
    return { text, redacted: [] }
  }

  const redacted: ShareRedaction[] = []

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      return node.map(walk)
    }
    if (node === null || typeof node !== 'object') {
      return node
    }
    const record = node as SerializedNode
    const type = record.type
    if (typeof type === 'string') {
      const blocked = SHARE_BLOCKED_NODE_TYPES[type]
      if (blocked !== undefined) {
        redacted.push({ type, reason: blocked.reason })
        return placeholderFor(blocked, record.format)
      }
    }
    // Recurse over EVERY value, not only `children`: the top level of a
    // serialized state is `{ root: {...} }`, so a walk that followed `children`
    // alone never descended into the document at all and reported nothing
    // redacted while leaving every blocked node in place.
    const copy: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      copy[key] = value !== null && typeof value === 'object' ? walk(value) : value
    }
    return copy
  }

  const rewritten = walk(parsed)
  if (redacted.length === 0) {
    return { text, redacted: [] }
  }
  return { text: JSON.stringify(rewritten), redacted }
}
