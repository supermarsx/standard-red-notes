describe('Super editor chunk preload', () => {
  beforeEach(() => jest.resetModules())

  it('shares the requested import with lazy rendering', async () => {
    const factory = jest.fn(() => ({ default: () => null }))
    jest.doMock('./SuperEditorLazy', factory)
    const { loadSuperEditor, preloadSuperEditor } = require('./loadSuperEditor')
    preloadSuperEditor()
    const first = loadSuperEditor()
    expect(loadSuperEditor()).toBe(first)
    await first
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('allows lazy rendering to retry after a failed speculative import', async () => {
    const factory = jest
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('chunk unavailable')
      })
      .mockImplementation(() => ({ default: () => null }))
    jest.doMock('./SuperEditorLazy', factory)
    const { loadSuperEditor, preloadSuperEditor } = require('./loadSuperEditor')
    preloadSuperEditor()
    await expect(loadSuperEditor()).rejects.toThrow('chunk unavailable')
    await expect(loadSuperEditor()).resolves.toHaveProperty('default')
    expect(factory).toHaveBeenCalledTimes(2)
  })
})
