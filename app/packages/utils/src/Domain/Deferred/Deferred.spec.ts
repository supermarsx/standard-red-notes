import { Deferred } from './Deferred'

describe('Deferred', () => {
  it('should resolve the promise with the supplied value', async () => {
    const deferred = Deferred<string>()

    deferred.resolve('done')

    await expect(deferred.promise).resolves.toBe('done')
  })

  it('should stay pending until resolve is called', async () => {
    const deferred = Deferred<string>()
    let settled = false
    void deferred.promise.then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(settled).toBe(false)

    deferred.resolve('now')
    await deferred.promise
    expect(settled).toBe(true)
  })

  it('should reject the promise when reject is called', async () => {
    const deferred = Deferred<string>()

    deferred.reject()

    await expect(deferred.promise).rejects.toBeUndefined()
  })

  it('should ignore a resolve that follows the first settlement', async () => {
    const deferred = Deferred<string>()

    deferred.resolve('first')
    deferred.resolve('second')

    await expect(deferred.promise).resolves.toBe('first')
  })

  it('should adopt a promise passed to resolve', async () => {
    const deferred = Deferred<string>()

    deferred.resolve(Promise.resolve('from promise'))

    await expect(deferred.promise).resolves.toBe('from promise')
  })
})
