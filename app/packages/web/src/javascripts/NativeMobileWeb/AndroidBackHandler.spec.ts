import { AndroidBackHandler } from './AndroidBackHandler'

describe('AndroidBackHandler dispatch', () => {
  it('stops at the first listener that claims the event and does not run the fallback', () => {
    const handler = new AndroidBackHandler()
    const order: string[] = []
    const fallback = jest.fn(() => true)

    handler.setFallbackListener(fallback)
    handler.addEventListener(() => {
      order.push('outer')
      return false
    })
    handler.addEventListener(() => {
      order.push('inner')
      return true
    })

    handler.notifyEvent()

    // Most-recently-registered first, and nothing past the claim.
    expect(order).toEqual(['inner'])
    expect(fallback).not.toHaveBeenCalled()
  })

  it('walks past listeners that decline, in reverse registration order', () => {
    const handler = new AndroidBackHandler()
    const order: string[] = []
    const fallback = jest.fn(() => true)

    handler.setFallbackListener(fallback)
    handler.addEventListener(() => {
      order.push('first')
      return true
    })
    handler.addEventListener(() => {
      order.push('second')
      return false
    })
    handler.addEventListener(() => {
      order.push('third')
      return false
    })

    handler.notifyEvent()

    expect(order).toEqual(['third', 'second', 'first'])
    expect(fallback).not.toHaveBeenCalled()
  })

  it('runs the fallback when every listener declines', () => {
    const handler = new AndroidBackHandler()
    const fallback = jest.fn(() => true)

    handler.setFallbackListener(fallback)
    handler.addEventListener(() => false)
    handler.addEventListener(() => false)

    handler.notifyEvent()

    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it('runs the fallback when there are no listeners at all', () => {
    const handler = new AndroidBackHandler()
    const fallback = jest.fn(() => true)

    handler.setFallbackListener(fallback)
    handler.notifyEvent()

    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it('does nothing and does not throw when nothing is registered', () => {
    const handler = new AndroidBackHandler()
    expect(() => handler.notifyEvent()).not.toThrow()
  })

  it('stops consulting a removed listener', () => {
    const handler = new AndroidBackHandler()
    const claiming = jest.fn(() => true)
    const fallback = jest.fn(() => true)

    handler.setFallbackListener(fallback)
    const remove = handler.addEventListener(claiming)

    remove()
    handler.notifyEvent()

    expect(claiming).not.toHaveBeenCalled()
    expect(fallback).toHaveBeenCalledTimes(1)
  })
})
