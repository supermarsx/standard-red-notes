import { useEffect, useState } from 'react'
import { sanitizeHtmlString } from '@standardnotes/snjs'
import { markdownToHtml } from '@/Utils/markdownToHtml'
import { decryptShare, SharePayload } from './shareCrypto'

type Props = {
  shareId: string
}

type ReadyMeta = {
  oneTimeView: boolean
  viewExpiresMinutes: number | null
}

type LoadState =
  | { status: 'loading' }
  | { status: 'gone' }
  | { status: 'invalid' }
  | { status: 'ready'; payload: SharePayload; meta: ReadyMeta }

const renderMarkdown = (text: string): string => sanitizeHtmlString(markdownToHtml(text ?? ''))

/**
 * Standard Red Notes: public, unauthenticated read-only viewer for a shared note
 * or tag bundle.
 *
 * The shareId comes from the `?shared=` query param; the decryption key comes
 * from the URL fragment (`#...`), which is never sent to the server. We fetch the
 * ciphertext with a bare unauthenticated fetch and decrypt it client-side, so
 * this component works with NO WebApplication / session.
 *
 * Screenshot DETERRENTS (see the overlay + selection/context-menu handlers below)
 * are BEST-EFFORT ONLY. The web platform cannot truly prevent screenshots: a user
 * can always photograph the screen or use OS-level capture before our handlers
 * react. Genuine capture blocking requires a native shell setting FLAG_SECURE
 * (Android) / the equivalent screen-capture protection on desktop/iOS, which a web
 * page has no access to. These measures only raise the effort/visibility bar.
 */
const SharedView = ({ shareId }: Props) => {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  // True while the page is hidden or unfocused — we cover the content so an
  // inactive-window or alt-tab screenshot shows the overlay, not the note. This
  // is a deterrent only and is trivially defeated by an OS screenshot of the
  // active window.
  const [obscured, setObscured] = useState(false)

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      // The key lives in the URL fragment and is never sent to the server.
      const keyHex = window.location.hash.replace(/^#/, '').trim()
      if (!keyHex) {
        if (!cancelled) {
          setState({ status: 'invalid' })
        }
        return
      }

      // Reach the API at the same host the authed app uses. The viewer has no
      // Application, but the server-injected `window.defaultSyncServer` config is
      // present on the page. Falling back to a relative path covers same-origin
      // (reverse-proxied) deployments.
      const apiHost = (window as { defaultSyncServer?: string }).defaultSyncServer ?? ''
      const apiBase = apiHost.replace(/\/$/, '')

      let response: Response
      try {
        response = await fetch(apiBase + '/v1/shares/' + encodeURIComponent(shareId), {
          headers: { Accept: 'application/json' },
        })
      } catch {
        if (!cancelled) {
          setState({ status: 'gone' })
        }
        return
      }

      if (response.status === 404) {
        if (!cancelled) {
          setState({ status: 'gone' })
        }
        return
      }

      if (!response.ok) {
        if (!cancelled) {
          setState({ status: 'gone' })
        }
        return
      }

      try {
        const body = (await response.json()) as {
          encryptedPayload?: string
          oneTimeView?: boolean
          viewExpiresMinutes?: number | null
        }
        if (!body.encryptedPayload) {
          throw new Error('Missing encrypted payload.')
        }
        const payload = await decryptShare(body.encryptedPayload, keyHex)
        if (!cancelled) {
          setState({
            status: 'ready',
            payload,
            meta: {
              oneTimeView: body.oneTimeView === true,
              viewExpiresMinutes: body.viewExpiresMinutes ?? null,
            },
          })
        }
      } catch {
        if (!cancelled) {
          setState({ status: 'invalid' })
        }
      }
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [shareId])

  // Screenshot deterrent: obscure the content whenever the tab is hidden or the
  // window loses focus. NOT reliable — an OS capture of the active window still
  // grabs the content before these fire.
  useEffect(() => {
    const hide = () => setObscured(true)
    const reveal = () => setObscured(false)
    const onVisibility = () => setObscured(document.visibilityState === 'hidden')

    window.addEventListener('blur', hide)
    window.addEventListener('focus', reveal)
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      window.removeEventListener('blur', hide)
      window.removeEventListener('focus', reveal)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  const isReady = state.status === 'ready'
  const isBurn = isReady && state.meta.oneTimeView
  const expiresMinutes = isReady ? state.meta.viewExpiresMinutes : null
  const watermark = `Confidential · ${new Date().toLocaleString()}`

  // Disable text selection + context menu on the shared content as a (weak)
  // copy/save deterrent. These do not stop screenshots or DevTools.
  const blockContextMenu = (event: React.MouseEvent) => {
    if (isReady) {
      event.preventDefault()
    }
  }

  return (
    <div
      className="relative flex h-full w-full justify-center overflow-auto bg-default px-4 py-10 text-foreground"
      onContextMenu={blockContextMenu}
    >
      <div className="w-full max-w-2xl">
        {state.status === 'loading' && <div className="text-center text-passive-0">Loading…</div>}

        {state.status === 'gone' && (
          <div className="rounded border border-solid border-border p-6 text-center">
            <div className="text-lg font-bold">Share unavailable</div>
            <div className="mt-2 text-passive-0">This share link is no longer available.</div>
          </div>
        )}

        {state.status === 'invalid' && (
          <div className="rounded border border-solid border-border p-6 text-center">
            <div className="text-lg font-bold">Invalid link</div>
            <div className="mt-2 text-passive-0">This share link is invalid or the key is missing.</div>
          </div>
        )}

        {isBurn && (
          <div className="mb-4 rounded border border-solid border-danger bg-danger-faded p-3 text-center text-sm">
            <div className="font-bold text-danger">This note self-destructs after viewing</div>
            <div className="mt-1">
              You are reading a one-time-view link. It has now been consumed and cannot be reopened
              {expiresMinutes != null ? `, and fully expires ${expiresMinutes} minute${
                expiresMinutes === 1 ? '' : 's'
              } from the first open` : ''}
              .
            </div>
          </div>
        )}

        {isReady && !isBurn && expiresMinutes != null && (
          <div className="mb-4 rounded border border-solid border-warning bg-warning-faded p-3 text-center text-sm">
            This link expires {expiresMinutes} minute{expiresMinutes === 1 ? '' : 's'} after it was first opened.
          </div>
        )}

        {state.status === 'ready' && state.payload.kind === 'note' && (
          <article className="select-none" style={{ WebkitUserSelect: 'none', userSelect: 'none' }}>
            <h1 className="mb-4 text-2xl font-bold">{state.payload.title || 'Untitled'}</h1>
            <div
              className="markdown-preview font-editor break-words"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(state.payload.text) }}
            />
          </article>
        )}

        {state.status === 'ready' && state.payload.kind === 'tag' && (
          <article className="select-none" style={{ WebkitUserSelect: 'none', userSelect: 'none' }}>
            <h1 className="mb-6 text-2xl font-bold">{state.payload.title || 'Untitled'}</h1>
            {state.payload.notes.length === 0 && <div className="text-passive-0">This tag has no notes.</div>}
            {state.payload.notes.map((note, index) => (
              <section key={index} className="mb-8 border-b border-solid border-border pb-6 last:border-b-0">
                <h2 className="mb-2 text-xl font-semibold">{note.title || 'Untitled'}</h2>
                <div
                  className="markdown-preview font-editor break-words"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(note.text) }}
                />
              </section>
            ))}
          </article>
        )}

        {state.status === 'ready' && (
          <div className="mt-10 border-t border-solid border-border pt-4 text-center text-xs text-passive-0">
            This is a public, read-only shared link. The content was decrypted in your browser.
          </div>
        )}
      </div>

      {/* Visible diagonal watermark over the content (deterrent + provenance). */}
      {isReady && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden opacity-10"
        >
          <span className="-rotate-45 whitespace-nowrap text-3xl font-bold uppercase tracking-widest">
            {watermark}
          </span>
        </div>
      )}

      {/* Blur/visibility overlay: hides content when the window is inactive. */}
      {isReady && obscured && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-default text-center">
          <div className="px-6">
            <div className="text-lg font-bold">Content hidden</div>
            <div className="mt-2 text-passive-0">Return focus to this window to view the shared content.</div>
          </div>
        </div>
      )}
    </div>
  )
}

export default SharedView
