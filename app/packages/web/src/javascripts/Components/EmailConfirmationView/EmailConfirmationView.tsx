import { useEffect, useState } from 'react'

type Props = {
  token: string
}

type VerifyState =
  { status: 'verifying' } | { status: 'success'; alreadyConfirmed: boolean } | { status: 'error'; message: string }

/**
 * Standard Red Notes: public, unauthenticated landing for the email-confirmation
 * link. The raw token arrives in the `?email_confirmation=` query param; on mount
 * we POST it to the verify endpoint with a bare fetch (this screen has NO
 * WebApplication / session, mirroring SharedView) and show success/failure. On
 * failure the user can request a fresh link by entering their email (the resend
 * endpoint always responds uniformly, so it never reveals whether the address
 * exists).
 */
const EmailConfirmationView = ({ token }: Props) => {
  const [state, setState] = useState<VerifyState>({ status: 'verifying' })
  const [resendEmail, setResendEmail] = useState('')
  const [resendState, setResendState] = useState<'idle' | 'sending' | 'sent'>('idle')

  // Reach the API at the same host the authed app uses; fall back to a relative
  // path for same-origin (reverse-proxied) deployments.
  const apiBase = ((window as { defaultSyncServer?: string }).defaultSyncServer ?? '').replace(/\/$/, '')

  useEffect(() => {
    let cancelled = false

    const verify = async () => {
      if (!token) {
        if (!cancelled) {
          setState({ status: 'error', message: 'This confirmation link is invalid.' })
        }
        return
      }

      try {
        const response = await fetch(apiBase + '/v1/users/email-confirmation/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ token }),
        })
        const body = (await response.json().catch(() => ({}))) as {
          success?: boolean
          alreadyConfirmed?: boolean
          error?: { message?: string }
        }

        if (cancelled) {
          return
        }

        if (response.ok && body.success) {
          setState({ status: 'success', alreadyConfirmed: body.alreadyConfirmed === true })
        } else {
          setState({
            status: 'error',
            message: body.error?.message ?? 'This confirmation link is invalid or has expired.',
          })
        }
      } catch {
        if (!cancelled) {
          setState({ status: 'error', message: 'Could not reach the server. Please try again later.' })
        }
      }
    }

    void verify()

    return () => {
      cancelled = true
    }
  }, [token, apiBase])

  const resend = async (event: React.FormEvent) => {
    event.preventDefault()
    if (resendEmail.trim() === '' || resendState === 'sending') {
      return
    }
    setResendState('sending')
    try {
      await fetch(apiBase + '/v1/users/email-confirmation/resend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email: resendEmail.trim() }),
      })
    } catch {
      // The endpoint responds uniformly; swallow network errors into the same
      // reassuring message so we never leak whether the address exists.
    }
    setResendState('sent')
  }

  return (
    <div className="bg-default text-foreground flex h-full w-full justify-center overflow-auto px-4 py-16">
      <div className="w-full max-w-md">
        <h1 className="mb-6 text-center text-2xl font-bold">Email confirmation</h1>

        {state.status === 'verifying' && (
          <div className="border-border text-passive-0 rounded border border-solid p-6 text-center">
            Confirming your email address…
          </div>
        )}

        {state.status === 'success' && (
          <div className="border-info bg-info-faded rounded border border-solid p-6 text-center">
            <div className="text-info text-lg font-bold">
              {state.alreadyConfirmed ? 'Already confirmed' : 'Email confirmed'}
            </div>
            <div className="text-passive-0 mt-2">
              {state.alreadyConfirmed
                ? 'Your email address was already confirmed. You can sign in.'
                : 'Thank you — your email address is confirmed. You can now sign in.'}
            </div>
            <a
              href="/"
              className="bg-info text-info-contrast mt-5 inline-block rounded px-4 py-2 font-semibold no-underline"
            >
              Continue to sign in
            </a>
          </div>
        )}

        {state.status === 'error' && (
          <div className="border-border rounded border border-solid p-6">
            <div className="text-danger text-center text-lg font-bold">Confirmation failed</div>
            <div className="text-passive-0 mt-2 text-center">{state.message}</div>

            {resendState === 'sent' ? (
              <div className="border-info bg-info-faded mt-6 rounded border border-solid p-3 text-center text-sm">
                If an account exists for that address and is not yet confirmed, a new confirmation link is on its way.
              </div>
            ) : (
              <form onSubmit={resend} className="mt-6">
                <label className="mb-1 block text-sm font-semibold">Request a new confirmation link</label>
                <input
                  type="email"
                  autoComplete="email"
                  required
                  value={resendEmail}
                  onChange={(event) => setResendEmail(event.target.value)}
                  placeholder="you@example.com"
                  className="border-border bg-default text-foreground w-full rounded border border-solid px-3 py-2"
                />
                <button
                  type="submit"
                  disabled={resendState === 'sending'}
                  className="bg-info text-info-contrast mt-3 w-full rounded px-4 py-2 font-semibold disabled:opacity-50"
                >
                  {resendState === 'sending' ? 'Sending…' : 'Send new link'}
                </button>
              </form>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default EmailConfirmationView
