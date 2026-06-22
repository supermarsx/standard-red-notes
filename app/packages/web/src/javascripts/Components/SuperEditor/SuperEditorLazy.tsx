import { SuperEditor } from './SuperEditor'

/**
 * Default-export shim for `React.lazy`. The Super (Lexical) editor pulls in the
 * entire Lexical core, ~40 plugins and all decorator nodes, none of which are
 * needed for first paint or for plain-text notes (the default note type). Lazy-
 * loading it here code-splits that whole subtree into an async chunk that is only
 * fetched when a Super note is actually opened. `SuperEditor` is a named export
 * (and its sibling `SuperNotePreviewCharLimit` constant is imported elsewhere),
 * so we re-export it as default here rather than changing the original module's
 * export shape.
 */
export default SuperEditor
