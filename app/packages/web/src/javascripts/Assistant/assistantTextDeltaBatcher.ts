export interface AssistantTextDeltaBatcher {
  push(delta: string): void
  flush(): void
  dispose(): void
}

/** Coalesces high-frequency stream deltas without delaying the provider loop. */
export function createAssistantTextDeltaBatcher(
  onFlush: (text: string) => void,
  delayMs = 40,
): AssistantTextDeltaBatcher {
  let pending = ''
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = () => {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    if (!pending) {
      return
    }
    const text = pending
    pending = ''
    onFlush(text)
  }

  return {
    push(delta) {
      pending += delta
      if (!timer) {
        timer = setTimeout(flush, delayMs)
      }
    },
    flush,
    dispose() {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      pending = ''
    },
  }
}
