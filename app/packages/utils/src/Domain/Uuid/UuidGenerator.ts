type PlatformCryptoLike = {
  getRandomValues?: <T extends ArrayBufferView>(array: T) => T
}

const getPlatformCrypto = (): PlatformCryptoLike | undefined => {
  return (globalThis as unknown as { crypto?: PlatformCryptoLike }).crypto
}

/**
 * Produces a genuine version 7 uuid from the platform CSPRNG. Used only when no generator has
 * been installed via SetGenerator — see GenerateUuid for why that can happen.
 *
 * Version 7 rather than `crypto.randomUUID`'s version 4 so a fallback id is indistinguishable
 * from the one the installed generator would have produced (sncrypto's generateUUID is uuid v7),
 * keeping the time-ordered prefix these ids are written with everywhere else. `getRandomValues`
 * is also available in insecure browser contexts, where `randomUUID` is not.
 */
const generateUuidFromPlatformCrypto = (): string => {
  const platformCrypto = getPlatformCrypto()

  if (!platformCrypto || typeof platformCrypto.getRandomValues !== 'function') {
    throw new Error('Cannot generate uuid: no generator was set and no platform crypto is available.')
  }

  const bytes = platformCrypto.getRandomValues(new Uint8Array(16))
  const milliseconds = Date.now()

  for (let index = 0; index < 6; index++) {
    bytes[index] = Math.floor(milliseconds / 2 ** (8 * (5 - index))) & 0xff
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  let hex = ''
  for (let index = 0; index < bytes.length; index++) {
    hex += bytes[index].toString(16).padStart(2, '0')
  }

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/**
 * An abstract class with no instance methods. Used globally to generate uuids by any
 * consumer. Application should call SetGenerator before use.
 */
export class UuidGenerator {
  private static syncUuidFunc: (() => string) | undefined

  /**
   * @param {function} syncImpl - A syncronous function that returns a UUID.
   */
  static SetGenerator(syncImpl: () => string): void {
    this.syncUuidFunc = syncImpl
  }

  /**
   * Generates a UUID string syncronously.
   *
   * This static field is per-module-instance, and bundling can produce more than one instance of
   * this module in a single runtime (the prebuilt snjs bundle inlines its own copy, while app
   * source importing '@standardnotes/utils' gets another). A reader holding an instance that
   * never had SetGenerator called on it must still return a real, unique uuid rather than throw
   * or return a placeholder, since these ids end up on synced items.
   */
  public static GenerateUuid(): string {
    if (typeof this.syncUuidFunc !== 'function') {
      return generateUuidFromPlatformCrypto()
    }

    return this.syncUuidFunc()
  }
}
