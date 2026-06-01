import { useEffect } from 'react'

export const useCaptcha = (captchaURL: string, callback: (token: string) => void) => {
  useEffect(() => {
    function handleCaptchaEvent(event: MessageEvent) {
      if (!captchaURL) {
        return
      }

      if (event.origin !== new URL(captchaURL).origin) {
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
  }, [callback, captchaURL])

  if (!captchaURL) {
    return null
  }

  return <iframe src={captchaURL} height={480}></iframe>
}
