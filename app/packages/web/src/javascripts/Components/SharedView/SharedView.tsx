import { useEffect, useState } from 'react'
import { sanitizeHtmlString } from '@standardnotes/snjs'
import { markdownToHtml } from '@/Utils/markdownToHtml'
import { decryptShare, SharePayload } from './shareCrypto'

type Props = {
  shareId: string
}

type LoadState =
  | { status: 'loading' }
  | { status: 'gone' }
  | { status: 'invalid' }
  | { status: 'ready'; payload: SharePayload }

const renderMarkdown = (text: string): string => sanitizeHtmlString(markdownToHtml(text ?? ''))

/**
 * Standard Red Notes: public, unauthenticated read-only viewer for a shared note
 * or tag bundle.
 *
 * The shareId comes from the `?shared=` query param; the decryption key comes
 * from the URL fragment (`#...`), which is never sent to the server. We fetch the
 * ciphertext with a bare unauthenticated fetch and decrypt it client-side, so
 * this component works with NO WebApplication / session.
 */
const SharedView = ({ shareId }: Props) => {
  const [state, setState] = useState<LoadState>({ status: 'loading' })

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
        const body = (await response.json()) as { encryptedPayload?: string }
        if (!body.encryptedPayload) {
          throw new Error('Missing encrypted payload.')
        }
        const payload = await decryptShare(body.encryptedPayload, keyHex)
        if (!cancelled) {
          setState({ status: 'ready', payload })
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

  return (
    <div className="flex h-full w-full justify-center overflow-auto bg-default px-4 py-10 text-foreground">
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

        {state.status === 'ready' && state.payload.kind === 'note' && (
          <article>
            <h1 className="mb-4 text-2xl font-bold">{state.payload.title || 'Untitled'}</h1>
            <div
              className="markdown-preview font-editor break-words"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(state.payload.text) }}
            />
          </article>
        )}

        {state.status === 'ready' && state.payload.kind === 'tag' && (
          <article>
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
    </div>
  )
}

export default SharedView
