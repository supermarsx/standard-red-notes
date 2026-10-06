import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { decryptShare, SharePayload, ShareDecryptFailureReason } from './shareCrypto'
import SharedNoteContent from './SharedNoteContent'
import { useSharedViewThemeContext } from './useSharedViewThemeContext'

type Props = {
  shareId: string
}

type ReadyMeta = {
  oneTimeView: boolean
  viewExpiresMinutes: number | null
}

/**
 * Why a share link could not be displayed. These used to be ONE `'invalid'`
 * state behind one sentence ("This share link is invalid or the key is
 * missing."), which meant a truncated link, a server that did not return the
 * ciphertext, a wrong key and a browser that could not load libsodium were
 * indistinguishable — on screen AND in the console, because the catch that
 * produced them swallowed the error. Each now renders its own copy and logs the
 * underlying error.
 */
type FailureReason =
  /** The URL fragment carried no key: everything after `#` was lost. */
  | 'missing-key'
  /** The server answered, but its reply carried no share envelope. */
  | 'unreadable'
  /** The envelope is here, but this key does not open it. */
  | 'undecryptable'
  /** libsodium never loaded, so no decrypt was even attempted. */
  | 'crypto-unavailable'
  /** Something else threw. Reported as itself rather than guessed at. */
  | 'unexpected'

type LoadState =
  | { status: 'loading' }
  | { status: 'gone' }
  | { status: 'failed'; reason: FailureReason }
  | { status: 'ready'; payload: SharePayload; meta: ReadyMeta }

/** The i18n title/message pair for each failure class. */
const FAILURE_COPY: Record<FailureReason, { title: string; message: string }> = {
  'missing-key': { title: 'missingKeyTitle', message: 'missingKeyMessage' },
  unreadable: { title: 'payloadUnreadableTitle', message: 'payloadUnreadableMessage' },
  undecryptable: { title: 'undecryptableTitle', message: 'undecryptableMessage' },
  'crypto-unavailable': { title: 'cryptoUnavailableTitle', message: 'cryptoUnavailableMessage' },
  unexpected: { title: 'unexpectedFailureTitle', message: 'unexpectedFailureMessage' },
}

/** What the public share read returns, once unwrapped. */
export type ShareEnvelope = {
  encryptedPayload: string
  oneTimeView: boolean
  viewExpiresMinutes: number | null
}

/**
 * The `NoteType` the share envelope declares, if it declares one.
 *
 * Read structurally rather than off `SharePayload`, for two reasons. The first
 * is historical: every link created before the field existed carries no note
 * type at all, so the viewer must cope with its absence anyway (it does — see
 * `resolveSharedNoteFormat`, which recognises Super from the text itself). The
 * second is ownership: `shareCrypto.ts` belongs to the embedded-assets work
 * right now, so the viewer consumes the field without requiring a change
 * there.
 */
const sharedNoteType = (payload: unknown): string | undefined => {
  const declared = (payload as { noteType?: unknown } | null)?.noteType
  return typeof declared === 'string' ? declared : undefined
}

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  return value as Record<string, unknown>
}

/**
 * Pull the ciphertext envelope out of the public share response.
 *
 * THE API GATEWAY WRAPS EVERY SERVICE RESPONSE as `{ meta, data }` — see
 * api-gateway `HttpServiceProxy.sendDecorated`, `DirectCallServiceProxy.
 * sendDecoratedResponse` and `GRPCServiceProxy` — and the front door is the only
 * door a share link ever knocks on, since `window.defaultSyncServer` is the app
 * origin. So the envelope lives at `data.encryptedPayload`.
 *
 * Reading ONLY the top level is the defect that made every single share link
 * render "invalid link": the fetch returned 200, the ciphertext was sitting one
 * level down, and the viewer threw "Missing encrypted payload." before the key
 * was ever used. Measured live against a share created through the real modal:
 * `{"meta":{…},"data":{"type":"note","encryptedPayload":"{\"v\":1,…}",…}}`.
 *
 * A deployment that points the client straight at the auth server (no gateway)
 * gets the unwrapped shape, so accept both rather than pinning one envelope.
 * The burn/expiry metadata is read from the SAME level as the payload, so it
 * cannot silently come back as "no burn" from the wrong level.
 */
export const readShareEnvelope = (body: unknown): ShareEnvelope | null => {
  const top = asRecord(body)
  if (top === null) {
    return null
  }

  for (const candidate of [asRecord(top.data), top]) {
    if (candidate === null) {
      continue
    }
    const encryptedPayload = candidate.encryptedPayload
    if (typeof encryptedPayload !== 'string' || encryptedPayload.length === 0) {
      continue
    }
    return {
      encryptedPayload,
      oneTimeView: candidate.oneTimeView === true,
      viewExpiresMinutes: typeof candidate.viewExpiresMinutes === 'number' ? candidate.viewExpiresMinutes : null,
    }
  }

  return null
}

/**
 * Map a {@link decryptShare} failure onto the class the reader sees.
 *
 * Reads a duck-typed `reason` rather than using `instanceof`: the viewer and
 * shareCrypto can be separated by a module mock or two bundle copies, and an
 * `instanceof` that quietly fails would re-conflate exactly what this splits.
 * An unrecognised error is reported as `'unexpected'`, never guessed into one of
 * the known classes.
 */
export const decryptFailureReason = (error: unknown): FailureReason => {
  const reason = asRecord(error)?.reason as ShareDecryptFailureReason | undefined

  switch (reason) {
    case 'crypto-unavailable':
      return 'crypto-unavailable'
    // A malformed envelope is the SERVER's side of the share being wrong; the key
    // was never applied, so blaming the link would point the reader at the one
    // thing they cannot fix.
    case 'malformed-envelope':
      return 'unreadable'
    case 'wrong-key':
      return 'undecryptable'
    default:
      return 'unexpected'
  }
}

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
  const { t } = useTranslation('sharing')
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  // True while the page is hidden or unfocused — we cover the content so an
  // inactive-window or alt-tab screenshot shows the overlay, not the note. This
  // is a deterrent only and is trivially defeated by an OS screenshot of the
  // active window.
  const [obscured, setObscured] = useState(false)

  // A public page has no signed-in user and therefore no installed theme, so it
  // inherits whatever the base palette happens to be. Declare the page a
  // theme context of its own instead — see useSharedViewThemeContext.
  useSharedViewThemeContext()

  useEffect(() => {
    let cancelled = false

    /**
     * Report a failure class and LOG why. The old code swallowed every one of
     * these in a bare `catch {}`, so a broken deployment produced no console
     * evidence at all. The log carries the failure class, the share id (already
     * public — it is in the query string) and the underlying error. It never
     * carries the fragment key or any decrypted content.
     */
    const fail = (reason: FailureReason, detail?: unknown) => {
      console.error(`[share] cannot display share ${shareId}: ${reason}`, detail ?? '')
      if (!cancelled) {
        setState({ status: 'failed', reason })
      }
    }

    const load = async () => {
      // The key lives in the URL fragment and is never sent to the server.
      const keyHex = window.location.hash.replace(/^#/, '').trim()
      if (!keyHex) {
        fail('missing-key')
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

      // Three distinct failures live between here and a rendered note, and each
      // gets its own catch. Wrapping them all in one was how a missing key, a
      // malformed server reply, a wrong key and a failed WASM load came to share
      // a single sentence.
      let body: unknown
      try {
        body = await response.json()
      } catch (error) {
        fail('unreadable', error)
        return
      }

      const envelope = readShareEnvelope(body)
      if (envelope === null) {
        fail('unreadable', new Error('The share response carried no encryptedPayload.'))
        return
      }

      let payload: SharePayload
      try {
        payload = await decryptShare(envelope.encryptedPayload, keyHex)
      } catch (error) {
        fail(decryptFailureReason(error), error)
        return
      }

      if (!cancelled) {
        setState({
          status: 'ready',
          payload,
          meta: {
            oneTimeView: envelope.oneTimeView,
            viewExpiresMinutes: envelope.viewExpiresMinutes,
          },
        })
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
  const watermark = t('confidentialWatermark', { datetime: new Date().toLocaleString() })

  // Disable text selection + context menu on the shared content as a (weak)
  // copy/save deterrent. These do not stop screenshots or DevTools.
  const blockContextMenu = (event: React.MouseEvent) => {
    if (isReady) {
      event.preventDefault()
    }
  }

  return (
    <div
      className="bg-default text-foreground relative flex h-full w-full justify-center overflow-auto px-4 py-10"
      onContextMenu={blockContextMenu}
    >
      <div className="w-full max-w-2xl">
        {state.status === 'loading' && <div className="text-passive-0 text-center">{t('common:loading')}</div>}

        {state.status === 'gone' && (
          <div className="border-border rounded border border-solid p-6 text-center">
            <div className="text-lg font-bold">{t('shareUnavailableTitle')}</div>
            <div className="text-passive-0 mt-2">{t('shareUnavailableMessage')}</div>
          </div>
        )}

        {state.status === 'failed' && (
          <div className="border-border rounded border border-solid p-6 text-center" data-failure-reason={state.reason}>
            <div className="text-lg font-bold">{t(FAILURE_COPY[state.reason].title)}</div>
            <div className="text-passive-0 mt-2">{t(FAILURE_COPY[state.reason].message)}</div>
            {/* The failure class, so a reader can quote it in a bug report. It is
                a fixed slug: it carries no key, no share content and no error text. */}
            <div className="text-passive-1 mt-4 text-xs">
              {t('technicalDetailLabel')}: <code>{state.reason}</code>
            </div>
          </div>
        )}

        {isBurn && (
          <div className="border-danger bg-danger-faded mb-4 rounded border border-solid p-3 text-center text-sm">
            <div className="text-danger font-bold">{t('selfDestructTitle')}</div>
            <div className="mt-1">
              {t('oneTimeViewConsumed')}
              {expiresMinutes != null ? t('oneTimeViewExpiresClause', { count: expiresMinutes }) : ''}.
            </div>
          </div>
        )}

        {isReady && !isBurn && expiresMinutes != null && (
          <div className="border-warning bg-warning-faded mb-4 rounded border border-solid p-3 text-center text-sm">
            {t('linkExpires', { count: expiresMinutes })}
          </div>
        )}

        {state.status === 'ready' && state.payload.kind === 'note' && (
          <article className="select-none" style={{ WebkitUserSelect: 'none', userSelect: 'none' }}>
            <h1 className="mb-4 text-2xl font-bold">{state.payload.title || t('untitled')}</h1>
            <SharedNoteContent text={state.payload.text} noteType={sharedNoteType(state.payload)} />
          </article>
        )}

        {state.status === 'ready' && state.payload.kind === 'tag' && (
          <article className="select-none" style={{ WebkitUserSelect: 'none', userSelect: 'none' }}>
            <h1 className="mb-6 text-2xl font-bold">{state.payload.title || t('untitled')}</h1>
            {state.payload.notes.length === 0 && <div className="text-passive-0">{t('tagHasNoNotes')}</div>}
            {state.payload.notes.map((note, index) => (
              <section key={index} className="border-border mb-8 border-b border-solid pb-6 last:border-b-0">
                <h2 className="mb-2 text-xl font-semibold">{note.title || t('untitled')}</h2>
                <SharedNoteContent text={note.text} noteType={sharedNoteType(note)} />
              </section>
            ))}
          </article>
        )}

        {state.status === 'ready' && (
          <div className="border-border text-passive-0 mt-10 border-t border-solid pt-4 text-center text-xs">
            {t('publicReadOnlyFooter')}
          </div>
        )}
      </div>

      {/* Visible diagonal watermark over the content (deterrent + provenance). */}
      {isReady && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden opacity-10"
        >
          <span className="-rotate-45 text-3xl font-bold tracking-widest whitespace-nowrap uppercase">{watermark}</span>
        </div>
      )}

      {/* Blur/visibility overlay: hides content when the window is inactive. */}
      {isReady && obscured && (
        <div className="bg-default absolute inset-0 z-10 flex items-center justify-center text-center">
          <div className="px-6">
            <div className="text-lg font-bold">{t('contentHiddenTitle')}</div>
            <div className="text-passive-0 mt-2">{t('contentHiddenMessage')}</div>
          </div>
        </div>
      )}
    </div>
  )
}

export default SharedView
