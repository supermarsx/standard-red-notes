import { useEffect, useRef, useState } from 'react'
import type { WebApplication } from '@/Application/WebApplication'
import { getAssistantAccountScope } from '@/Assistant/personaSettings'
import { telegramBridgeRequest } from '@/Assistant/telegramBridge'
import { confirmDialog } from '@standardnotes/ui-services'

export default function TelegramBridgeSetting({ application }: { application: WebApplication }) {
  const [status, setStatus] = useState<Record<string, unknown>>()
  const [pairing, setPairing] = useState<string>()
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const scope = getAssistantAccountScope(application)
  useEffect(() => {
    const version = ++generation.current
    setBusy(false)
    setStatus(undefined)
    setPairing(undefined)
    void telegramBridgeRequest(application, 'inbox').then((result) => {
      if (version === generation.current) {
        setStatus(result)
      }
    })
    return () => {
      generation.current = version + 1
    }
  }, [application, scope])
  const run = async (action: 'inbox' | 'pair' | 'revoke' | 'ack') => {
    if (busy) {
      return
    }
    const version = generation.current
    setBusy(true)
    if (
      action === 'ack' &&
      !(await confirmDialog({
        title: 'Clear the Telegram inbox?',
        text: 'This removes pending messages from this app, not Telegram. Check any uncertain replies in Telegram first.',
        confirmButtonText: 'Clear inbox',
      }))
    ) {
      setBusy(false)
      return
    }
    if (scope !== getAssistantAccountScope(application)) {
      return
    }
    const body =
      action === 'ack'
        ? {
            updateIds: Array.isArray(status?.messages)
              ? status.messages.map((message: { updateId: number }) => message.updateId)
              : [],
          }
        : {}
    const result = await telegramBridgeRequest(application, action, body)
    if (version !== generation.current || scope !== getAssistantAccountScope(application)) {
      return
    }
    setBusy(false)
    if (action === 'pair' && typeof result.code === 'string') {
      setPairing(`/start ${result.code}`)
    } else {
      setStatus(
        !result.error && (action === 'ack' || action === 'revoke')
          ? { ...status, messages: [], ...(action === 'revoke' ? { linked: false } : {}) }
          : result,
      )
      if (action === 'revoke' && !result.error) {
        setPairing(undefined)
      }
    }
  }
  return (
    <div className="mt-3 text-sm">
      <p className="font-medium">Telegram bridge</p>
      <p className="text-passive-1 mt-1 text-xs">
        Connect your private bot chat. Ask the Assistant to read its inbox; outgoing replies require approval. Telegram
        messages are readable by Telegram and this server. Notes are not automatically sent.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button className="border-border rounded border px-2 py-1" disabled={busy} onClick={() => void run('pair')}>
          Pair bot
        </button>
        <button className="border-border rounded border px-2 py-1" disabled={busy} onClick={() => void run('inbox')}>
          Refresh status
        </button>
        <button className="border-border rounded border px-2 py-1" disabled={busy} onClick={() => void run('revoke')}>
          Disconnect
        </button>
        <button
          className="border-border rounded border px-2 py-1"
          disabled={busy || !Array.isArray(status?.messages) || !status.messages.length}
          onClick={() => void run('ack')}
        >
          Clear inbox
        </button>
      </div>
      {pairing && (
        <div className="mt-2">
          <p className="text-passive-1 text-xs">
            Send this command to your server’s configured bot within ten minutes:
          </p>
          <input
            aria-label="Telegram pairing command"
            readOnly
            value={pairing}
            onFocus={(event) => event.target.select()}
            className="border-border bg-default text-default mt-1 w-full rounded border px-2 py-1 text-xs"
          />
        </div>
      )}
      {typeof status?.error === 'string' ? (
        <p role="alert" className="text-danger mt-1 text-xs">
          {status.error}
        </p>
      ) : (
        status && (
          <p className="text-passive-1 mt-1 text-xs">
            {status.linked
              ? 'Connected'
              : status.configured
                ? 'Not paired'
                : 'Ask your administrator to configure the Telegram bot.'}
          </p>
        )
      )}
    </div>
  )
}
