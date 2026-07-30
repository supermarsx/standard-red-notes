import { log, LoggingDomain } from '@/Logging'
import { useEffect, useRef } from 'react'

type Props = {
  contextData?: Record<string, unknown>
  onResponse: (response: Record<string, unknown>) => void
  apiHost: string
}

// Self-hosted: the `?route=u2f` view is served by this same app (see App.tsx),
// so the WebAuthn iframe loads from our own origin rather than a hosted domain.
const U2F_IFRAME_URL = `${window.location.origin}/?route=u2f`
const U2F_IFRAME_ORIGIN = window.location.origin

const U2FPromptIframeContainer = ({ contextData, onResponse, apiHost }: Props) => {
  const iframeRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    const messageHandler = (event: MessageEvent) => {
      log(LoggingDomain.U2F, 'Native client received message', event)
      const eventDoesNotComeFromU2FIFrame =
        event.source !== iframeRef.current?.contentWindow || event.origin !== U2F_IFRAME_ORIGIN
      if (eventDoesNotComeFromU2FIFrame) {
        log(LoggingDomain.U2F, 'Ignoring U2F message; source or origin does not match', event.origin, U2F_IFRAME_ORIGIN)
        return
      }

      const data = event.data as Record<string, unknown> | null
      if (!data || typeof data !== 'object') {
        return
      }

      if (data.mountedAuthView === true) {
        if (iframeRef.current?.contentWindow) {
          log(LoggingDomain.U2F, 'Sending contextData to U2F iframe', contextData)
          iframeRef.current.contentWindow.postMessage({ username: contextData?.username, apiHost }, U2F_IFRAME_ORIGIN)
        }
        return
      }

      const assertionResponse = data.assertionResponse
      if (assertionResponse && typeof assertionResponse === 'object' && !Array.isArray(assertionResponse)) {
        log(LoggingDomain.U2F, 'Received assertion response from U2F iframe', assertionResponse)
        onResponse(assertionResponse as Record<string, unknown>)
      }
    }

    window.addEventListener('message', messageHandler)

    return () => {
      window.removeEventListener('message', messageHandler)
    }
  }, [contextData, onResponse, apiHost])

  return (
    <iframe
      ref={iframeRef}
      src={U2F_IFRAME_URL}
      className="h-40 w-full"
      title="U2F"
      allow="publickey-credentials-get"
      id="u2f"
    />
  )
}

export default U2FPromptIframeContainer
