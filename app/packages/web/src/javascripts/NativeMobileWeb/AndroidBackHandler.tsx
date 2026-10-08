type Listener = () => boolean
type RemoveListener = () => void

export class AndroidBackHandler {
  private listeners = new Set<Listener>()
  private fallbackListener: Listener | undefined

  setFallbackListener(listener: Listener) {
    this.fallbackListener = listener
  }

  addEventListener(listener: Listener): RemoveListener {
    this.listeners.add(listener)

    return () => {
      this.listeners.delete(listener)
    }
  }

  notifyEvent() {
    // Most-recently-registered listener first. The first one that claims the
    // event ends the dispatch; the fallback runs only when nobody claimed it.
    // The `handled` flag this used to carry was written and then immediately
    // abandoned by the `return`, so it never reached the fallback test.
    for (const listener of Array.from(this.listeners).reverse()) {
      if (listener()) {
        return
      }
    }
    if (this.fallbackListener) {
      this.fallbackListener()
    }
  }
}
