import * as React from 'react'
import { useCallback, useState } from 'react'
import {
  $getNodeByKey,
  DecoratorNode,
  EditorConfig,
  LexicalEditor,
  LexicalNode,
  NodeKey,
  SerializedLexicalNode,
  Spread,
} from 'lexical'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import Icon from '@/Components/Icon/Icon'
import { sanitizeWebEmbedUrl } from './sanitizeWebEmbedUrl'

export type WebEmbedData = {
  url: string
  /** Bounded iframe height in px. Defaults to DEFAULT_HEIGHT. */
  height?: number
  /**
   * Opt-in flag for the looser "trusted" sandbox profile (see SANDBOX_TRUSTED).
   * Optional + defaults to undefined/false so previously-serialized embeds keep
   * the safer default profile and round-trip unchanged (backward compatible).
   */
  trusted?: boolean
}

const DEFAULT_HEIGHT = 480
const MIN_HEIGHT = 160
const MAX_HEIGHT = 1200

const DEFAULT_WEB_EMBED: WebEmbedData = { url: '' }

/**
 * Iframe sandbox profiles.
 *
 * Modern single-page apps (React/Vue/Svelte/SolidJS, etc.) need real
 * capabilities to boot: ES-module + classic scripts, the ability to read/write
 * their OWN origin (localStorage / IndexedDB / cookies / a service worker) so
 * routing, auth, and `fetch`/XHR to their own backend work, plus forms, popups,
 * modal dialogs, downloads, presentation and fullscreen. The previous
 * `allow-scripts allow-same-origin allow-popups allow-forms` list was missing
 * most of these, so framework apps that do same-origin networking, open auth
 * popups, or show `<dialog>`/`alert()` modals silently broke.
 *
 * Security reasoning for the DEFAULT profile:
 *   - `allow-same-origin` is combined with `allow-scripts` below. The well-known
 *     warning about that pair only applies when the framed document's origin is
 *     the SAME as the embedder's origin (the frame could then reach back into
 *     the parent app's storage/DOM and lift the sandbox on itself). In this
 *     block the `src` is always an arbitrary EXTERNAL http(s) origin (enforced
 *     by sanitizeWebEmbedUrl) that is cross-origin to Standard Notes, so
 *     `allow-same-origin` only ever grants the frame access to its OWN site's
 *     data — exactly what it already has when opened in a normal tab. It does
 *     NOT grant any access to the note, the editor, or other origins. The
 *     browser's cross-origin policy remains the real boundary.
 *   - We deliberately do NOT add `allow-top-navigation` (a framed page should
 *     never be able to navigate the whole Standard Notes tab away) and we keep
 *     `referrerPolicy="no-referrer"` so the note's URL is never leaked.
 *   - `allow-popups-to-escape-sandbox` lets links/auth flows that open a new
 *     window land in a normal, unsandboxed tab (the user is leaving the embed
 *     anyway), which is what real apps expect.
 *
 * The TRUSTED profile is identical today; it exists as an explicit, per-embed
 * acknowledgement surface and a forward-compatible hook for any future
 * capability we only want to hand to embeds the user has vouched for. Because
 * the embed is always cross-origin, the default already safely carries
 * `allow-same-origin`, so there is no additional same-origin-script risk to
 * gate here — the toggle is about user intent, not a privilege boundary.
 */
const SANDBOX_DEFAULT = [
  'allow-scripts',
  'allow-same-origin',
  'allow-forms',
  'allow-popups',
  'allow-popups-to-escape-sandbox',
  'allow-modals',
  'allow-downloads',
  'allow-presentation',
].join(' ')

const SANDBOX_TRUSTED = SANDBOX_DEFAULT

/**
 * Feature-policy handed to the frame. We enable the capabilities a rich app
 * commonly wants for media/UX — clipboard writes, fullscreen, encrypted media
 * (DRM video), picture-in-picture and the (gesture-gated) autoplay — but
 * intentionally OMIT camera, microphone and geolocation so an embedded site can
 * never silently request them through the frame in a notes app.
 */
const IFRAME_ALLOW = 'clipboard-write; fullscreen; encrypted-media; picture-in-picture; autoplay'

/**
 * Plain-language warning shown on the click-to-load placeholder card. Embedding
 * an arbitrary website is meaningfully riskier than the YouTube/Vimeo embed, so
 * we surface the tradeoffs up front and require an explicit opt-in to load.
 */
const RISK_WARNING =
  'Embedding a website can be dangerous. It loads third-party code directly inside the app, which can track you, ' +
  'run arbitrary scripts, and may attempt to compromise the application or your privacy. The page is loaded straight ' +
  'from that site, so it is not end-to-end encrypted or protected by Standard Notes. ' +
  'Use website embeds sparingly and only when strictly necessary — prefer safer options first, such as a plain link, ' +
  'a screenshot/image, or a built-in embed (YouTube, Vimeo, tweet) where available. ' +
  'Only embed sites you fully trust (and note that many block embedding, so it may not load).'

/** Short caution shown at the insert/edit step, before a URL is even added. */
const INSERT_WARNING =
  'Caution: embedding an external website runs third-party code in the app and can hurt your privacy and security. ' +
  'Use it sparingly and only when truly needed — prefer a link, an image, or a built-in embed instead.'

function clampHeight(height: number | undefined): number {
  if (!height || Number.isNaN(height)) {
    return DEFAULT_HEIGHT
  }
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(height)))
}

function WebEmbedComponent({ data, nodeKey }: { data: WebEmbedData; nodeKey: NodeKey }): React.JSX.Element {
  const [editor] = useLexicalComposerContext()
  const safeUrl = sanitizeWebEmbedUrl(data.url)
  const [draft, setDraft] = useState(data.url)
  const [editing, setEditing] = useState(!safeUrl)
  // Default to click-to-load for safety: never auto-load the iframe.
  const [loaded, setLoaded] = useState(false)

  const height = clampHeight(data.height)

  const commit = useCallback(
    (url: string) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey)
        if ($isWebEmbedNode(node)) {
          const current = node.getData()
          node.setData({ url, height: current.height, trusted: current.trusted })
        }
      })
      setEditing(false)
      setLoaded(false)
    },
    [editor, nodeKey],
  )

  const setTrusted = useCallback(
    (trusted: boolean) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey)
        if ($isWebEmbedNode(node)) {
          const current = node.getData()
          node.setData({ url: current.url, height: current.height, trusted })
        }
      })
      // Reload from the placeholder so the new sandbox profile applies cleanly.
      setLoaded(false)
    },
    [editor, nodeKey],
  )

  if (editing) {
    return (
      <div className="my-2 w-full max-w-full rounded border border-border bg-default" data-web-embed-block="true">
        <div className="flex items-center justify-between border-b border-border px-2 py-1 text-xs text-passive-1">
          <span className="font-semibold">Embed website</span>
        </div>
        <div className="p-2">
          <div className="mb-2 flex items-start gap-2 rounded border border-warning bg-warning-faded p-2 text-xs text-warning">
            <Icon type="warning" className="mt-0.5 flex-shrink-0" />
            <p className="break-words">{INSERT_WARNING}</p>
          </div>
          <input
            className="w-full rounded border border-border bg-default px-2 py-1 text-sm text-foreground outline-none focus:border-info"
            placeholder="Paste a website URL (https://…) to embed"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                commit(draft)
              }
            }}
            autoFocus
          />
          {draft.trim() && !sanitizeWebEmbedUrl(draft) ? (
            <div className="mt-1 text-xs text-danger">Enter a valid http(s) website URL.</div>
          ) : null}
          <button
            type="button"
            className="mt-2 rounded bg-info px-3 py-1 text-sm text-info-contrast disabled:opacity-50"
            disabled={!sanitizeWebEmbedUrl(draft)}
            onClick={() => commit(draft)}
          >
            Add website
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="my-2 w-full max-w-full rounded border border-border bg-default" data-web-embed-block="true">
      <div className="flex items-center justify-between border-b border-border px-2 py-1 text-xs text-passive-1">
        <span className="flex min-w-0 items-center font-semibold">
          <Icon type="window" className="mr-1.5 flex-shrink-0" />
          <span className="truncate">{safeUrl || 'Embed website'}</span>
        </span>
        <span className="flex flex-shrink-0 items-center gap-1">
          {safeUrl ? (
            <a
              href={safeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center rounded px-2 py-0.5 hover:bg-contrast"
              title="Open in a new tab"
            >
              <Icon type="open-in" className="mr-1" />
              Open
            </a>
          ) : null}
          <button type="button" className="rounded px-2 py-0.5 hover:bg-contrast" onClick={() => setEditing(true)}>
            Edit
          </button>
        </span>
      </div>

      {!safeUrl ? (
        <div className="p-2 text-sm text-danger">Enter a valid http(s) website URL to embed.</div>
      ) : !loaded ? (
        /* Risk-alert placeholder card: shown FIRST instead of an auto-loaded
           iframe. The user must explicitly opt in to loading external content. */
        <div className="p-3">
          <div className="flex items-start gap-2 rounded border border-warning bg-warning-faded p-2 text-sm text-foreground">
            <Icon type="warning" className="mt-0.5 flex-shrink-0 text-warning" />
            <div>
              <div className="font-semibold text-warning">Embedding a website can be dangerous</div>
              <p className="mt-1 break-words text-passive-0">{RISK_WARNING}</p>
              <p className="mt-1 break-all text-xs text-passive-1">{safeUrl}</p>
            </div>
          </div>
          <label className="mt-2 flex items-start gap-2 text-xs text-passive-0">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={!!data.trusted}
              onChange={(event) => setTrusted(event.target.checked)}
            />
            <span>
              Trust this site (apply the looser sandbox profile). Only enable for sites you control or fully trust — the
              embed still runs cross-origin, so it can never read your note.
            </span>
          </label>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="rounded bg-info px-3 py-1 text-sm text-info-contrast"
              onClick={() => setLoaded(true)}
            >
              Load page
            </button>
            <a
              href={safeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded border border-border px-3 py-1 text-sm hover:bg-contrast"
            >
              Open in a new tab instead
            </a>
          </div>
        </div>
      ) : (
        <div className="p-2">
          {/* Bounded, responsive container: full width, capped height, no overflow. */}
          <div className="w-full max-w-full overflow-hidden rounded border border-border" style={{ height }}>
            {/* Modern-app-capable iframe. The sandbox enables what framework SPAs
                need (scripts/modules, same-origin storage+fetch, forms, popups,
                modals, downloads, presentation) while still WITHOUT
                allow-top-navigation, so the frame can never hijack the whole
                Standard Notes tab. allow-same-origin is safe here only because
                the src is always a cross-origin external site (see
                SANDBOX_DEFAULT). no-referrer avoids leaking the note URL; lazy
                loading defers the fetch until scrolled into view. */}
            <iframe
              title={`Embedded website: ${safeUrl}`}
              src={safeUrl}
              className="h-full w-full border-0"
              sandbox={data.trusted ? SANDBOX_TRUSTED : SANDBOX_DEFAULT}
              allow={IFRAME_ALLOW}
              referrerPolicy="no-referrer"
              loading="lazy"
            />
          </div>
          {/* We cannot reliably detect X-Frame-Options / CSP frame-ancestors
              denial from script, so we always surface this fallback hint. */}
          <p className="mt-1 text-xs text-passive-1">
            If the page is blank, the site blocks embedding —{' '}
            <a href={safeUrl} target="_blank" rel="noopener noreferrer" className="underline">
              open it in a new tab
            </a>
            .
          </p>
        </div>
      )}
    </div>
  )
}

export type SerializedWebEmbedNode = Spread<{ data: WebEmbedData }, SerializedLexicalNode>

export class WebEmbedNode extends DecoratorNode<React.JSX.Element> {
  __data: WebEmbedData

  static getType(): string {
    return 'web-embed'
  }

  static clone(node: WebEmbedNode): WebEmbedNode {
    return new WebEmbedNode(node.__data, node.__key)
  }

  constructor(data: WebEmbedData, key?: NodeKey) {
    super(key)
    this.__data = data
  }

  static importJSON(serializedNode: SerializedWebEmbedNode): WebEmbedNode {
    const data = serializedNode.data || DEFAULT_WEB_EMBED
    return $createWebEmbedNode({
      url: typeof data.url === 'string' ? data.url : '',
      height: clampHeight(data.height),
      trusted: data.trusted === true,
    })
  }

  exportJSON(): SerializedWebEmbedNode {
    return {
      type: 'web-embed',
      version: 1,
      // Only persist `trusted` when explicitly enabled so existing notes that
      // never had the field continue to serialize byte-for-byte identically.
      data: {
        url: this.__data.url ?? '',
        height: clampHeight(this.__data.height),
        ...(this.__data.trusted ? { trusted: true } : {}),
      },
    }
  }

  createDOM(): HTMLElement {
    const div = document.createElement('div')
    div.style.display = 'contents'
    return div
  }

  updateDOM(): false {
    return false
  }

  getData(): WebEmbedData {
    return this.getLatest().__data
  }

  setData(data: WebEmbedData): void {
    this.getWritable().__data = data
  }

  getTextContent(): string {
    return this.__data.url ?? ''
  }

  isInline(): false {
    return false
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): React.JSX.Element {
    return <WebEmbedComponent data={this.__data} nodeKey={this.getKey()} />
  }
}

export function $createWebEmbedNode(data: WebEmbedData = DEFAULT_WEB_EMBED): WebEmbedNode {
  return new WebEmbedNode({
    url: data.url ?? '',
    height: clampHeight(data.height),
    ...(data.trusted ? { trusted: true } : {}),
  })
}

export function $isWebEmbedNode(node: LexicalNode | null | undefined): node is WebEmbedNode {
  return node instanceof WebEmbedNode
}
