/**
 * Standard Red Notes: make the images a shared note embeds travel WITH the
 * share, and make every one that cannot say so on screen.
 *
 *
 * THE VERDICT THIS MODULE ANSWERS — measured on a live stack, not inferred
 *
 * A Super note embeds an uploaded file as a Lexical `snfile` node carrying ONE
 * thing: the file's uuid. The bytes live in the files service behind
 * `ValetTokenAuthMiddleware`; the file's decryption key lives in the FileItem's
 * content, encrypted under the account's items key. The share envelope (see
 * `shareCrypto.ts`) carries `{ kind, title, text }`.
 *
 * So a share link has none of the three things an image needs:
 *   - no session: `POST /v1/files/valet-tokens` answers 401 (measured),
 *   - no valet token: `GET /v1/files` answers 401 (measured),
 *   - no file key: the envelope never carried one.
 *
 * And the reader's browser never even tries. Measured against a live single
 * container: an anonymous visit to a share link whose note embeds an image
 * issued exactly two requests — the page and `GET /v1/shares/<id>` — and
 * rendered zero `<img>` elements. The honest classification is therefore
 * **it was never wired**, with "the bytes are unreachable" and "there is no key
 * to decrypt them with" as the two reasons the obvious wiring would also fail.
 *
 *
 * WHAT THIS DOES
 *
 * At share-creation time, while the OWNER still holds a session and the items
 * key, each embedded image is downloaded, decrypted, and spliced into the
 * note's own Lexical JSON as a {@link SharedImageNode} whose `src` is a `data:`
 * URL. That node is deliberately inert — no `useApplication`, no preferences,
 * no network — so the public viewer renders it with no application and no
 * session. Anything that cannot be included becomes the SAME node in its
 * placeholder state, naming the file and the reason, because a silently
 * missing image is the one outcome the reader cannot detect.
 *
 *
 * WHY NOT A SHARE-SCOPED FILE TOKEN
 *
 * Every server-side alternative has to mint a credential that lets an anonymous
 * caller read one account's file bytes: a new unauthenticated capability over
 * the files service, with its own scoping, expiry, revocation and enumeration
 * story to get right. This codebase has already shipped an authorization
 * abstraction (per-item signature trust) that read as though it enforced
 * something and had zero production call sites, so "there is a check" is not
 * worth much here.
 *
 * Inlining introduces NO credential at all. The bytes live inside the same
 * ciphertext, under the same fragment key, in the same row, with exactly the
 * same expiry and revocation as the note text. A neighbouring file is not
 * reachable because it is not present — a property of the data, not of a check
 * that has to run. The server still sees only ciphertext: the images are
 * encrypted by {@link encryptShare} under a key that lives in the URL fragment
 * and is never transmitted.
 *
 *
 * THE COSTS, STATED
 *
 *  - A share is a SNAPSHOT. It already was (the note text is copied at creation
 *    time too); now the images are copied at that moment as well.
 *  - The envelope grows. Bounded by the two caps below, enforced here on the
 *    owner's machine before anything is uploaded. MySQL's `TEXT` column could
 *    not have held it — it tops out at 65,535 bytes and TRUNCATES silently
 *    outside strict mode — so `shares.encrypted_payload` is widened to
 *    `LONGTEXT` by migration `1791700000000-share-payload-longtext`. SQLite
 *    needs no change: its TEXT affinity has no length limit (proved against a
 *    real database in `SharePayloadLongTextMigrations.spec.ts`).
 *  - Images are copied to anyone holding the link. The share modal says so
 *    BEFORE the link is created, and reports afterwards exactly what travelled
 *    and what did not.
 *
 *
 * WHAT REACHES THE VIEWER (the contract the renderer reads)
 *
 * Only two node shapes are ever produced, both `shared-image`:
 *   { type:'shared-image', version:1, src:'data:<mime>;base64,…', mimeType,
 *     fileName, width?, caption?, float }                      — an image
 *   { type:'shared-image', version:1, reason, message, fileName, float }
 *                                                              — a placeholder
 * Every `snfile` node is replaced by one of them, so a share's text contains no
 * `snfile` node and no file uuid at all.
 */

import { formatSizeToReadableString } from '@standardnotes/filepicker'

import { resolvePreviewKind } from '@/Components/FilePreview/isFilePreviewable'
import {
  isRenderableSharedImageSource,
  SHARED_IMAGE_NODE_TYPE,
  SharedImageOmissionReason,
} from '@/Components/SuperEditor/Lexical/Nodes/SharedImageNode'

/** The Lexical node type a Super note uses for an embedded account file. */
export const SHARE_ASSET_SOURCE_NODE_TYPE = 'snfile'

/** The node type this module emits. Re-exported so the viewer has one import. */
export const SHARE_ASSET_NODE_TYPE = SHARED_IMAGE_NODE_TYPE

/**
 * Per-image ceiling on DECRYPTED bytes. Covers screenshots and web imagery;
 * refuses a full-resolution phone photo, which would dominate the envelope on
 * its own. Enforced BEFORE the file is downloaded (from the FileItem's recorded
 * `decryptedSize`) and again on the bytes that actually arrive.
 */
export const SHARE_ASSET_MAX_FILE_BYTES = 2 * 1024 * 1024

/**
 * Ceiling on the DECRYPTED bytes of every image in one share. Base64 inflates
 * by 4/3, so the worst-case envelope is ~8.4 MB — inside the server's default
 * 50 MB request limit (`HTTP_REQUEST_PAYLOAD_LIMIT_MEGABYTES`) and inside
 * MariaDB's 16 MB `max_allowed_packet`. Images past this point are left out
 * with a `budget-exhausted` placeholder rather than making the link too heavy
 * to open.
 */
export const SHARE_ASSET_MAX_TOTAL_BYTES = 6 * 1024 * 1024

/**
 * Why one embedded file is not in the share. Each renders its own sentence: a
 * reader told "too large" knows to ask the author for the file; a reader told
 * "no longer in the author's account" knows the author cannot resend it.
 * Collapsing them would put the reader back where a missing image leaves them.
 */
export type ShareAssetOmissionReason = Exclude<SharedImageOmissionReason, 'unsafe-source'>

export type ShareAssetOmission = {
  fileUuid: string
  /** The attachment's display name, when the account still holds the file. */
  name?: string
  reason: ShareAssetOmissionReason
}

export type InlineShareAssetsResult = {
  /** The note text to put in the share envelope. */
  text: string
  /** How many distinct files were embedded as `data:` URLs. */
  inlined: number
  /** Every embedded file that did NOT make it, with the reason the reader sees. */
  omitted: ShareAssetOmission[]
  /** Total DECRYPTED bytes inlined. */
  bytes: number
}

/** The slice of a FileItem this module needs. Structural, so tests need no snjs. */
export type ShareAssetFile = {
  uuid: string
  name: string
  mimeType: string
  decryptedSize: number
}

/**
 * Where the owner's plaintext bytes come from. Separated from the walk so every
 * refusal below is reachable in a unit test without a live account.
 *
 * `readFileBytes` must return `null` for any failure. It is NOT trusted to
 * honour `maxBytes`: a buffer longer than the cap is treated as a failure, so
 * the cap remains a cap even if the reader misbehaves.
 */
export type ShareAssetSource = {
  findFile: (fileUuid: string) => ShareAssetFile | undefined
  readFileBytes: (file: ShareAssetFile, maxBytes: number) => Promise<Uint8Array | null>
}

type LexicalNode = {
  type?: unknown
  children?: unknown
  [key: string]: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Every `snfile` in the document, as `(parent array, index)` so the node can be
 * REPLACED rather than mutated. Replacement matters: an `snfile` and a
 * `shared-image` share no fields, and mutating one into the other would leave
 * `fileUuid` behind — the one identifier this transform stops publishing.
 */
function collectFileNodeSlots(root: unknown): { parent: unknown[]; index: number; node: LexicalNode }[] {
  const slots: { parent: unknown[]; index: number; node: LexicalNode }[] = []

  const walkChildren = (children: unknown): void => {
    if (!Array.isArray(children)) {
      return
    }
    children.forEach((child, index) => {
      if (!isRecord(child)) {
        return
      }
      if (child.type === SHARE_ASSET_SOURCE_NODE_TYPE) {
        slots.push({ parent: children, index, node: child })
      }
      walkChildren(child.children)
    })
  }

  if (isRecord(root)) {
    walkChildren(root.children)
  }

  return slots
}

/** Base64 without blowing the stack on a multi-megabyte buffer. */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  }
  return btoa(binary)
}

/**
 * The sentence the reader sees in place of an image that is not here. It names
 * the file wherever the name is known, because "an attachment" tells the reader
 * nothing they can act on.
 */
export function shareAssetPlaceholderText(omission: ShareAssetOmission, sizeBytes?: number): string {
  const named = omission.name ? `“${omission.name}”` : 'An attachment'

  switch (omission.reason) {
    case 'not-found':
      return `[${named} is referenced by this note but is no longer in the author’s account, so it is not part of this share link.]`
    case 'not-an-image':
      return `[${named} is attached to this note. Share links carry embedded images only, so it is not included here.]`
    case 'too-large':
      return `[${named}${sizeBytes === undefined ? '' : ` (${formatSizeToReadableString(sizeBytes)})`} is too large to embed in a share link, so it is not included here.]`
    case 'budget-exhausted':
      return `[${named} was left out: this share link already carries its maximum of embedded images.]`
    case 'content-mismatch':
      return `[${named} could not be verified as the image it claims to be, so it is not included in this share link.]`
    case 'download-failed':
      return `[${named} could not be read while this share link was created, so it is not included here.]`
  }
}

function floatOf(node: LexicalNode): 'none' | 'left' | 'right' {
  return node.float === 'left' || node.float === 'right' ? node.float : 'none'
}

function placeholderNode(omission: ShareAssetOmission, sizeBytes: number | undefined, node: LexicalNode): LexicalNode {
  return {
    type: SHARED_IMAGE_NODE_TYPE,
    version: 1,
    reason: omission.reason,
    message: shareAssetPlaceholderText(omission, sizeBytes),
    fileName: omission.name,
    float: floatOf(node),
  }
}

function imageNode(source: string, file: ShareAssetFile, node: LexicalNode): LexicalNode {
  return {
    type: SHARED_IMAGE_NODE_TYPE,
    version: 1,
    src: source,
    mimeType: file.mimeType,
    fileName: file.name,
    // Carried across so a resized / captioned / floated image keeps its layout.
    width: typeof node.width === 'number' ? node.width : undefined,
    caption: typeof node.caption === 'string' ? node.caption : undefined,
    float: floatOf(node),
  }
}

/** One resolved decision for a file uuid, reused when the note embeds it twice. */
type Resolution =
  | { kind: 'inline'; source: string; file: ShareAssetFile }
  | { kind: 'omit'; omission: ShareAssetOmission; sizeBytes?: number }

async function resolveFile(
  fileUuid: string,
  source: ShareAssetSource,
  remainingBytes: () => number,
  spend: (bytes: number) => void,
): Promise<Resolution> {
  const file = source.findFile(fileUuid)
  if (!file) {
    return { kind: 'omit', omission: { fileUuid, reason: 'not-found' } }
  }

  const named = { fileUuid, name: file.name }

  // The metadata gate first: it is free, and it is the one that keeps a PDF, a
  // video or an SVG out of a public envelope entirely.
  if (resolvePreviewKind({ mimeType: file.mimeType, name: file.name }) !== 'image') {
    return { kind: 'omit', omission: { ...named, reason: 'not-an-image' } }
  }

  if (file.decryptedSize > SHARE_ASSET_MAX_FILE_BYTES) {
    return { kind: 'omit', omission: { ...named, reason: 'too-large' }, sizeBytes: file.decryptedSize }
  }

  if (file.decryptedSize > remainingBytes()) {
    return { kind: 'omit', omission: { ...named, reason: 'budget-exhausted' }, sizeBytes: file.decryptedSize }
  }

  let bytes: Uint8Array | null
  try {
    bytes = await source.readFileBytes(file, Math.min(SHARE_ASSET_MAX_FILE_BYTES, remainingBytes()))
  } catch {
    bytes = null
  }

  if (bytes === null) {
    return { kind: 'omit', omission: { ...named, reason: 'download-failed' } }
  }

  // A reader that over-delivers is a failure, not a bigger budget: trusting the
  // returned length is how a cap stops being a cap.
  if (bytes.length === 0 || bytes.length > SHARE_ASSET_MAX_FILE_BYTES || bytes.length > remainingBytes()) {
    return { kind: 'omit', omission: { ...named, reason: 'too-large' }, sizeBytes: bytes.length }
  }

  const dataUrl = `data:${file.mimeType};base64,${encodeBase64(bytes)}`

  // The declared MIME is the author's metadata, not evidence, so the bytes
  // themselves are checked before anything becomes an `<img>` source for a
  // stranger — and the check used is EXACTLY the one the node applies at
  // render, on exactly the string the node will receive.
  //
  // There was a separate `hasSupportedImageSignature(bytes)` call above this.
  // It was removed, not forgotten: every signature it tests lives in the first
  // twelve bytes, and `isRenderableSharedImageSource` runs the same function
  // over a forty-eight byte prefix of the same bytes, so the two agreed on
  // every reachable input. A mutation run proved it — deleting the first check
  // changed no test — and a gate whose removal changes nothing is not a gate.
  // One check, shared with the renderer by construction, is the honest shape:
  // the sharer can never be told an image travelled that the reader will then
  // be shown a placeholder for.
  if (!isRenderableSharedImageSource(dataUrl, file.mimeType, file.name)) {
    return { kind: 'omit', omission: { ...named, reason: 'content-mismatch' } }
  }

  spend(bytes.length)
  return { kind: 'inline', source: dataUrl, file }
}

/**
 * Rewrite a Super note's Lexical JSON so every embedded image travels inside
 * the share, and every one that cannot says so on screen.
 *
 * Returns the ORIGINAL string untouched when the text is not a Lexical document
 * (a plain or markdown note) or holds no embedded files, so a note with no
 * attachments is byte-for-byte what it was.
 */
export async function inlineShareAssets(text: string, source: ShareAssetSource): Promise<InlineShareAssetsResult> {
  const unchanged: InlineShareAssetsResult = { text, inlined: 0, omitted: [], bytes: 0 }

  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    return unchanged
  }

  if (!isRecord(document) || !isRecord(document.root)) {
    return unchanged
  }

  const slots = collectFileNodeSlots(document.root)
  if (slots.length === 0) {
    return unchanged
  }

  let spent = 0
  const remainingBytes = () => Math.max(0, SHARE_ASSET_MAX_TOTAL_BYTES - spent)
  const spend = (bytes: number) => {
    spent += bytes
  }

  const resolutions = new Map<string, Resolution>()
  const omitted: ShareAssetOmission[] = []
  let inlined = 0

  for (const slot of slots) {
    const fileUuid = typeof slot.node.fileUuid === 'string' ? slot.node.fileUuid : ''

    let resolution = resolutions.get(fileUuid)
    if (!resolution) {
      resolution =
        fileUuid.length === 0
          ? { kind: 'omit', omission: { fileUuid: '', reason: 'not-found' } }
          : await resolveFile(fileUuid, source, remainingBytes, spend)
      resolutions.set(fileUuid, resolution)
      if (resolution.kind === 'omit') {
        omitted.push(resolution.omission)
      } else {
        inlined += 1
      }
    }

    slot.parent[slot.index] =
      resolution.kind === 'inline'
        ? imageNode(resolution.source, resolution.file, slot.node)
        : placeholderNode(resolution.omission, resolution.sizeBytes, slot.node)
  }

  return { text: JSON.stringify(document), inlined, omitted, bytes: spent }
}

/**
 * The owner-side adapter. Narrowly typed against what it actually calls, so a
 * WebApplication is not needed to test it and a change to either method's
 * signature is a compile error here rather than a silent runtime miss.
 */
export type ShareAssetApplication = {
  items: { findItem(uuid: string): unknown }
  files: {
    /**
     * Declared with method shorthand ON PURPOSE. The real `downloadFile` takes
     * a `FileItem`; a property-typed signature would be checked
     * contravariantly and reject the narrower {@link ShareAssetFile} this
     * module works in, even though the value handed back is the very item
     * `findItem` returned.
     */
    downloadFile(
      file: ShareAssetFile,
      onDecryptedBytes: (bytes: Uint8Array) => Promise<void>,
      options?: { signal?: AbortSignal },
    ): Promise<unknown>
  }
}

const isShareAssetFile = (value: unknown): value is ShareAssetFile =>
  isRecord(value) &&
  typeof value.uuid === 'string' &&
  typeof value.name === 'string' &&
  typeof value.mimeType === 'string' &&
  typeof value.decryptedSize === 'number'

/**
 * Read an owner's file through the real download/decrypt path, bounded.
 *
 * `downloadFile` streams chunks and resolves with a `ClientDisplayableError` (a
 * truthy object) on failure and `undefined` on success, so a TRUTHY result is a
 * failure — reading it the other way round is how a failed download becomes a
 * zero-byte "image" nobody can tell is broken.
 */
export function createApplicationShareAssetSource(
  application: ShareAssetApplication,
  options: { signal?: AbortSignal } = {},
): ShareAssetSource {
  return {
    findFile: (fileUuid) => {
      const item: unknown = application.items.findItem(fileUuid)
      return isShareAssetFile(item) ? item : undefined
    },
    readFileBytes: async (file, maxBytes) => {
      const chunks: Uint8Array[] = []
      let received = 0
      let overflowed = false

      const error = await application.files.downloadFile(
        file,
        async (bytes) => {
          received += bytes.length
          if (received > maxBytes) {
            overflowed = true
            return
          }
          chunks.push(bytes.slice())
        },
        { signal: options.signal },
      )

      if (error || overflowed || received === 0) {
        return null
      }

      const out = new Uint8Array(received)
      let offset = 0
      for (const chunk of chunks) {
        out.set(chunk, offset)
        offset += chunk.length
      }
      return out
    },
  }
}
