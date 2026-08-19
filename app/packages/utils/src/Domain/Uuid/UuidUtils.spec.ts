import { UuidGenerator } from './UuidGenerator'
import { Uuids } from './Utils'

describe('Uuids', () => {
  it('should map items to their uuids in order', () => {
    expect(Uuids([{ uuid: 'a' }, { uuid: 'b' }, { uuid: 'c' }])).toEqual(['a', 'b', 'c'])
  })

  it('should return an empty array for no items', () => {
    expect(Uuids([])).toEqual([])
  })
})

describe('UuidGenerator', () => {
  it('should delegate to the generator that was set', () => {
    const generator = jest.fn().mockReturnValue('generated-uuid')
    UuidGenerator.SetGenerator(generator)

    expect(UuidGenerator.GenerateUuid()).toBe('generated-uuid')
    expect(generator).toHaveBeenCalledTimes(1)
  })

  it('should use the most recently set generator', () => {
    UuidGenerator.SetGenerator(() => 'first')
    UuidGenerator.SetGenerator(() => 'second')

    expect(UuidGenerator.GenerateUuid()).toBe('second')
  })

  describe('when no generator was set on this module instance', () => {
    const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

    const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
    const originalCrypto = globalThis.crypto

    const replaceCrypto = (value: unknown) => {
      Object.defineProperty(globalThis, 'crypto', { value, configurable: true, writable: true })
    }

    beforeEach(() => {
      /**
       * Bundling can produce more than one instance of this module in a single runtime, so a
       * reader may hold a copy that never had SetGenerator called on it. That copy must still
       * produce a real uuid: a throw breaks the caller, and a placeholder would put a duplicate
       * identifier on a synced item.
       */
      ;(UuidGenerator as unknown as { syncUuidFunc: undefined }).syncUuidFunc = undefined
    })

    afterEach(() => {
      if (originalCryptoDescriptor) {
        Object.defineProperty(globalThis, 'crypto', originalCryptoDescriptor)
      }
    })

    it('should generate a unique version 7 uuid from the platform CSPRNG', () => {
      expect(UuidGenerator.GenerateUuid()).toMatch(uuidV7Pattern)
      expect(UuidGenerator.GenerateUuid()).not.toBe(UuidGenerator.GenerateUuid())
    })

    it('should keep the time-ordered prefix so a fallback id sorts with the generated ones', () => {
      const before = UuidGenerator.GenerateUuid()
      jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000)
      const after = UuidGenerator.GenerateUuid()
      jest.restoreAllMocks()

      expect(after.slice(0, 8) > before.slice(0, 8)).toBe(true)
    })

    it('should work without randomUUID, which insecure browser contexts do not expose', () => {
      replaceCrypto({ getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto) })

      expect(UuidGenerator.GenerateUuid()).toMatch(uuidV7Pattern)
      expect(UuidGenerator.GenerateUuid()).not.toBe(UuidGenerator.GenerateUuid())
    })

    it('should throw rather than invent an identifier when no crypto source exists', () => {
      replaceCrypto(undefined)

      expect(() => UuidGenerator.GenerateUuid()).toThrow('no platform crypto is available')
    })
  })
})
