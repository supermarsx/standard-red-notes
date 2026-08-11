import { registerRafCoalescedScrollListener } from './registerRafCoalescedScrollListener'

type QueuedFrame = {
  id: number
  callback: FrameRequestCallback
}

function createAnimationFrameHost() {
  const queuedFrames: QueuedFrame[] = []
  let nextFrameId = 1

  const host: Pick<Window, 'requestAnimationFrame' | 'cancelAnimationFrame'> = {
    requestAnimationFrame: jest.fn((callback: FrameRequestCallback) => {
      const id = nextFrameId++
      queuedFrames.push({ id, callback })
      return id
    }),
    cancelAnimationFrame: jest.fn((id: number) => {
      const index = queuedFrames.findIndex((frame) => frame.id === id)
      if (index >= 0) {
        queuedFrames.splice(index, 1)
      }
    }),
  }

  return {
    host,
    flushNextFrame: () => queuedFrames.shift()?.callback(0),
    queuedFrames,
  }
}

describe('registerRafCoalescedScrollListener', () => {
  it('coalesces scroll events and defers positioning and menu closure until the next frame', () => {
    const target = document.createElement('div')
    const addEventListener = jest.spyOn(target, 'addEventListener')
    const { host, flushNextFrame, queuedFrames } = createAnimationFrameHost()
    const menu = document.createElement('button')
    let isMenuOpen = true
    const update = jest.fn(() => {
      menu.style.transform = 'translate(12px, 24px)'
      isMenuOpen = false
    })

    const cleanup = registerRafCoalescedScrollListener(target, update, host)

    expect(addEventListener).toHaveBeenCalledWith('scroll', expect.any(Function), { passive: true })
    target.dispatchEvent(new Event('scroll'))
    target.dispatchEvent(new Event('scroll'))

    expect(menu.style.transform).toBe('')
    expect(isMenuOpen).toBe(true)
    expect(update).not.toHaveBeenCalled()
    expect(host.requestAnimationFrame).toHaveBeenCalledTimes(1)
    expect(queuedFrames).toHaveLength(1)

    flushNextFrame()

    expect(menu.style.transform).toBe('translate(12px, 24px)')
    expect(isMenuOpen).toBe(false)
    expect(update).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('removes the listener and cancels pending work during cleanup', () => {
    const target = document.createElement('div')
    const removeEventListener = jest.spyOn(target, 'removeEventListener')
    const { host, flushNextFrame, queuedFrames } = createAnimationFrameHost()
    const update = jest.fn()

    const cleanup = registerRafCoalescedScrollListener(target, update, host)
    target.dispatchEvent(new Event('scroll'))
    cleanup()

    expect(removeEventListener).toHaveBeenCalledWith('scroll', expect.any(Function))
    expect(host.cancelAnimationFrame).toHaveBeenCalledTimes(1)
    expect(queuedFrames).toHaveLength(0)
    flushNextFrame()
    target.dispatchEvent(new Event('scroll'))
    expect(update).not.toHaveBeenCalled()
    expect(host.requestAnimationFrame).toHaveBeenCalledTimes(1)
  })
})
