import { useEffect, useRef } from 'react'

function getCaptchaOrigin(captchaURL: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(captchaURL)
  } catch {
    return undefined
  }

  if (parsed.protocol === 'https:') {
    return parsed.origin
  }

  // Keep local development usable without accepting plaintext captcha frames
  // from remote hosts. URL normalizes IPv4 shorthand before this check.
  const hostname = parsed.hostname.toLowerCase()
  const isLoopback =
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.startsWith('127.') ||
    hostname === '[::1]' ||
    hostname === '::1'

  return parsed.protocol === 'http:' && isLoopback ? parsed.origin : undefined
}

export const useCaptcha = (captchaURL: string, callback: (token: string) => void) => {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const expectedOrigin = getCaptchaOrigin(captchaURL)

  useEffect(() => {
    if (!expectedOrigin) {
      return
    }

    function handleCaptchaEvent(event: MessageEvent) {
      if (event.source !== iframeRef.current?.contentWindow || event.origin !== expectedOrigin) {
        return
      }

      const data = event.data as { type?: string; token?: string } | undefined
      if (data?.type?.includes('captcha') && data.token) {
        callback(data.token)
      }
    }

    window.addEventListener('message', handleCaptchaEvent)

    return () => {
      window.removeEventListener('message', handleCaptchaEvent)
    }
  }, [callback, expectedOrigin])

  if (!captchaURL || !expectedOrigin) {
    return null
  }

  return <iframe ref={iframeRef} src={captchaURL} height={480} title="Captcha"></iframe>
}
