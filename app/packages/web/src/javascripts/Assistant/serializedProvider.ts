import { Provider, ProviderEvent, ProviderRequest } from './types'
/** Delegates share a run lease, but its proof admits exactly one upstream stream at a time. */
export function serializeAssistantProvider(provider: Provider): Provider {
  let tail = Promise.resolve()
  return {
    id: provider.id,
    async *send(request: ProviderRequest): AsyncIterable<ProviderEvent> {
      const previous = tail
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      tail = previous.then(
        () => gate,
        () => gate,
      )
      let abort: (() => void) | undefined
      try {
        const cancelled = new Promise<never>((_resolve, reject) => {
          abort = () => reject(request.signal?.reason ?? new Error('Assistant request cancelled.'))
          request.signal?.addEventListener('abort', abort, { once: true })
        })
        if (request.signal?.aborted) {
          throw request.signal.reason ?? new Error('Assistant request cancelled.')
        }
        await Promise.race([previous, cancelled])
        for await (const event of provider.send(request)) {
          yield event
        }
      } finally {
        if (abort) {
          request.signal?.removeEventListener('abort', abort)
        }
        release()
      }
    },
  }
}
