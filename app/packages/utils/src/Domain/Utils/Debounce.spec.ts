import { debounce } from './Debounce'

describe('debounce', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('should not invoke the function before the wait elapses', () => {
    const func = jest.fn()
    const debounced = debounce(func, 50)

    void debounced()
    jest.advanceTimersByTime(49)

    expect(func).not.toHaveBeenCalled()
  })

  it('should invoke the function once the wait elapses', () => {
    const func = jest.fn()
    const debounced = debounce(func, 50)

    void debounced()
    jest.advanceTimersByTime(50)

    expect(func).toHaveBeenCalledTimes(1)
  })

  it('should collapse a burst of calls into a single trailing invocation', () => {
    const func = jest.fn()
    const debounced = debounce(func, 50)

    void debounced('a')
    jest.advanceTimersByTime(20)
    void debounced('b')
    jest.advanceTimersByTime(20)
    void debounced('c')
    jest.advanceTimersByTime(50)

    expect(func).toHaveBeenCalledTimes(1)
    expect(func).toHaveBeenCalledWith('c')
  })

  it('should resolve every pending promise with the invocation result', async () => {
    const debounced = debounce((value: number) => value * 2, 50)

    const first = debounced(1)
    const second = debounced(2)
    jest.advanceTimersByTime(50)

    await expect(first).resolves.toBe(4)
    await expect(second).resolves.toBe(4)
  })

  it('should preserve the caller `this`', () => {
    const context = { value: 7, seen: 0 }
    function target(this: typeof context) {
      this.seen = this.value
    }
    const debounced = debounce(target, 50)

    void debounced.call(context)
    jest.advanceTimersByTime(50)

    expect(context.seen).toBe(7)
  })

  it('should notify the callback option with the result', () => {
    const callback = jest.fn()
    const debounced = debounce(() => 'result', 50, { callback })

    void debounced()
    jest.advanceTimersByTime(50)

    expect(callback).toHaveBeenCalledWith('result')
  })

  describe('isImmediate', () => {
    it('should invoke on the leading edge and resolve straight away', async () => {
      const func = jest.fn().mockReturnValue('now')
      const debounced = debounce(func, 50, { isImmediate: true })

      const result = debounced()

      expect(func).toHaveBeenCalledTimes(1)
      await expect(result).resolves.toBe('now')
    })

    it('should suppress further calls until the window closes', () => {
      const func = jest.fn()
      const debounced = debounce(func, 50, { isImmediate: true })

      void debounced()
      void debounced()
      jest.advanceTimersByTime(50)

      expect(func).toHaveBeenCalledTimes(1)
    })

    it('should invoke again once the window has closed', () => {
      const func = jest.fn()
      const debounced = debounce(func, 50, { isImmediate: true })

      void debounced()
      jest.advanceTimersByTime(50)
      void debounced()

      expect(func).toHaveBeenCalledTimes(2)
    })

    it('should notify the callback option on the leading edge', () => {
      const callback = jest.fn()
      const debounced = debounce(() => 'lead', 50, { isImmediate: true, callback })

      void debounced()

      expect(callback).toHaveBeenCalledWith('lead')
    })
  })

  describe('maxWait', () => {
    it('should force an invocation once maxWait is reached despite continued calls', () => {
      const func = jest.fn()
      const debounced = debounce(func, 50, { maxWait: 80 })

      void debounced()
      jest.advanceTimersByTime(40)
      void debounced()
      jest.advanceTimersByTime(40)

      expect(func).toHaveBeenCalledTimes(1)
    })

    it('should still use the normal wait while well inside maxWait', () => {
      const func = jest.fn()
      const debounced = debounce(func, 50, { maxWait: 500 })

      void debounced()
      jest.advanceTimersByTime(49)

      expect(func).not.toHaveBeenCalled()

      jest.advanceTimersByTime(1)
      expect(func).toHaveBeenCalledTimes(1)
    })
  })

  describe('cancel', () => {
    it('should prevent a pending invocation', () => {
      const func = jest.fn()
      const debounced = debounce(func, 50)

      const pending = debounced()
      pending.catch(() => undefined)
      debounced.cancel()
      jest.advanceTimersByTime(100)

      expect(func).not.toHaveBeenCalled()
    })

    it('should reject the pending promises with the supplied reason', async () => {
      const debounced = debounce(() => 'never', 50)

      const pending = debounced()
      debounced.cancel(new Error('cancelled'))

      await expect(pending).rejects.toThrow('cancelled')
    })

    it('should be safe to call when nothing is pending', () => {
      const debounced = debounce(jest.fn(), 50)

      expect(() => debounced.cancel()).not.toThrow()
    })
  })
})
