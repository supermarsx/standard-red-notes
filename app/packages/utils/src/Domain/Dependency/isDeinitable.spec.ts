import { canBlockDeinit, isDeinitable } from './isDeinitable'

describe('isDeinitable', () => {
  it('should be true for a service exposing a deinit function', () => {
    expect(isDeinitable({ deinit: () => undefined })).toBe(true)
  })

  it('should be false for a service without deinit', () => {
    expect(isDeinitable({ other: () => undefined })).toBe(false)
  })

  it('should be false when deinit is not a function', () => {
    expect(isDeinitable({ deinit: 'nope' })).toBe(false)
  })

  it('should throw for undefined, null and other falsy services', () => {
    expect(() => isDeinitable(undefined)).toThrow('Service is undefined')
    expect(() => isDeinitable(null)).toThrow('Service is undefined')
    expect(() => isDeinitable(0)).toThrow('Service is undefined')
  })
})

describe('canBlockDeinit', () => {
  it('should be true for a service exposing a blockDeinit function', () => {
    expect(canBlockDeinit({ blockDeinit: () => Promise.resolve() })).toBe(true)
  })

  it('should be false for a service without blockDeinit', () => {
    expect(canBlockDeinit({ deinit: () => undefined })).toBe(false)
  })

  it('should throw for undefined and null services', () => {
    expect(() => canBlockDeinit(undefined)).toThrow('Service is undefined')
    expect(() => canBlockDeinit(null)).toThrow('Service is undefined')
  })
})
