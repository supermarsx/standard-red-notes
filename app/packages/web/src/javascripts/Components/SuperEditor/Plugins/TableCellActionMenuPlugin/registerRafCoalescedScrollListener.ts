type AnimationFrameHost = Pick<Window, 'requestAnimationFrame' | 'cancelAnimationFrame'>

/**
 * Run scroll-linked DOM work on the next animation frame instead of inside the
 * scroll event dispatch. Besides coalescing high-frequency events, this keeps
 * inline positioning writes out of Firefox's scroll-linked-effect detector.
 */
export function registerRafCoalescedScrollListener(
  target: EventTarget,
  callback: () => void,
  animationFrameHost: AnimationFrameHost = window,
): () => void {
  let pendingFrame: number | undefined

  const onScroll = () => {
    if (pendingFrame !== undefined) {
      return
    }

    pendingFrame = animationFrameHost.requestAnimationFrame(() => {
      pendingFrame = undefined
      callback()
    })
  }

  target.addEventListener('scroll', onScroll, { passive: true })

  return () => {
    target.removeEventListener('scroll', onScroll)
    if (pendingFrame !== undefined) {
      animationFrameHost.cancelAnimationFrame(pendingFrame)
      pendingFrame = undefined
    }
  }
}
