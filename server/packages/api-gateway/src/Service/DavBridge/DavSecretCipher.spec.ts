import { inspect } from 'util'

import { EmailDeliveryCipher } from '../EmailDelivery/EmailDeliveryEncryption'
import {
  DAV_ACCOUNT_SECRET_ENCRYPTION_CONTEXT,
  DavSecretCipher,
  DavSecretStoreUnavailableError,
  DavSecretUnreadableError,
} from './DavSecretCipher'
import { SecretString } from './SecretString'
import { sentinel, TEST_SERVER_KEY } from './DavBridgeTestKit.spec'

const USER = '11111111-1111-4111-8111-111111111111'
const OTHER_USER = '22222222-2222-4222-8222-222222222222'
const ACCOUNT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_ACCOUNT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

describe('SecretString', () => {
  const marker = sentinel('secretstring')
  const secret = new SecretString(marker.value)

  it('gives the plaintext through reveal() and through nothing else', () => {
    // The positive control: the value is really in there.
    expect(secret.reveal()).toBe(marker.value)

    const renderings = [
      String(secret),
      `${secret}`,
      secret.toString(),
      JSON.stringify(secret),
      JSON.stringify({ secret }),
      JSON.stringify([secret]),
      inspect(secret),
      inspect({ nested: { secret } }, { depth: 10, showHidden: true }),
      Object.prototype.toString.call(secret),
      JSON.stringify(Object.entries(secret)),
      JSON.stringify(Object.getOwnPropertyNames(secret)),
      JSON.stringify({ ...secret }),
      JSON.stringify(Object.assign({}, secret)),
      new Error(`failed for ${secret}`).message,
      // What a structured logger does to metadata.
      JSON.stringify({ meta: { account: { secret } } }, (_key, value: unknown) => value),
    ]

    for (const rendering of renderings) {
      for (const window of marker.windows) {
        expect(rendering).not.toContain(window)
      }
    }
    expect(String(secret)).toBe('[REDACTED]')
    expect(JSON.stringify({ secret })).toBe('{"secret":"[REDACTED]"}')
    expect(inspect(secret)).toBe('[REDACTED]')
  })

  it('has no enumerable or own property holding the value', () => {
    expect(Object.keys(secret)).toEqual([])
    expect(Object.getOwnPropertyNames(secret)).toEqual([])
    expect(Object.getOwnPropertySymbols(secret)).toEqual([])
  })
})

describe('DavSecretCipher', () => {
  const cipher = new DavSecretCipher(TEST_SERVER_KEY)

  it('opens what it sealed, for the same user and account', () => {
    const marker = sentinel('roundtrip')
    const envelope = cipher.seal(new SecretString(marker.value), USER, ACCOUNT)

    expect(cipher.open(envelope, USER, ACCOUNT).reveal()).toBe(marker.value)
  })

  it('stores ciphertext: the envelope does not contain the secret in any encoding a search would find', () => {
    const marker = sentinel('atrest')
    const envelope = JSON.stringify(cipher.seal(new SecretString(marker.value), USER, ACCOUNT))

    for (const needle of [
      ...marker.windows,
      Buffer.from(marker.value).toString('base64').slice(0, 24),
      Buffer.from(marker.value).toString('base64url').slice(0, 24),
      Buffer.from(marker.value).toString('hex').slice(0, 24),
    ]) {
      expect(envelope).not.toContain(needle)
    }
    expect(JSON.parse(envelope)).toEqual({
      v: 1,
      alg: 'A256GCM',
      iv: expect.any(String),
      tag: expect.any(String),
      ciphertext: expect.any(String),
    })
  })

  it('seals the same secret to a different envelope every time', () => {
    const first = cipher.seal(new SecretString('same'), USER, ACCOUNT)
    const second = cipher.seal(new SecretString('same'), USER, ACCOUNT)

    expect(first.iv).not.toBe(second.iv)
    expect(first.ciphertext).not.toBe(second.ciphertext)
  })

  it("does not open an envelope moved into another user's file", () => {
    const envelope = cipher.seal(new SecretString('app-password'), USER, ACCOUNT)

    expect(() => cipher.open(envelope, OTHER_USER, ACCOUNT)).toThrow(DavSecretUnreadableError)
  })

  it('does not open an envelope moved onto another account', () => {
    const envelope = cipher.seal(new SecretString('app-password'), USER, ACCOUNT)

    expect(() => cipher.open(envelope, USER, OTHER_ACCOUNT)).toThrow(DavSecretUnreadableError)
  })

  it('cannot be confused by ids whose text runs together', () => {
    const envelope = cipher.seal(new SecretString('app-password'), 'ab', 'c')

    expect(() => cipher.open(envelope, 'a', 'bc')).toThrow(DavSecretUnreadableError)
    expect(() => cipher.open(envelope, 'abc', '')).toThrow(DavSecretUnreadableError)
    expect(cipher.open(envelope, 'ab', 'c').reveal()).toBe('app-password')
  })

  it('does not open after the server key changed', () => {
    const envelope = cipher.seal(new SecretString('app-password'), USER, ACCOUNT)
    const rotated = new DavSecretCipher('b2'.repeat(32))

    expect(() => rotated.open(envelope, USER, ACCOUNT)).toThrow(DavSecretUnreadableError)
  })

  it('does not open a tampered envelope', () => {
    const envelope = cipher.seal(new SecretString('app-password'), USER, ACCOUNT)
    const flipped = envelope.ciphertext.startsWith('A') ? 'B' : 'A'

    expect(() =>
      cipher.open({ ...envelope, ciphertext: `${flipped}${envelope.ciphertext.slice(1)}` }, USER, ACCOUNT),
    ).toThrow(DavSecretUnreadableError)
    expect(() => cipher.open({ ...envelope, tag: 'A'.repeat(22) }, USER, ACCOUNT)).toThrow(DavSecretUnreadableError)
    expect(() => cipher.open({ v: 1 } as never, USER, ACCOUNT)).toThrow(DavSecretUnreadableError)
  })

  it('uses its own derived key: an envelope from another use of the server key does not open', () => {
    const relaySettings = new EmailDeliveryCipher(TEST_SERVER_KEY)
    const foreign = relaySettings.encrypt({ secret: 'smtp-password' })
    const sameContextUnbound = new EmailDeliveryCipher(TEST_SERVER_KEY, DAV_ACCOUNT_SECRET_ENCRYPTION_CONTEXT).encrypt({
      secret: 'unbound',
    })

    expect(() => cipher.open(foreign, USER, ACCOUNT)).toThrow(DavSecretUnreadableError)
    // Right key, right context, but not bound to any user or account.
    expect(() => cipher.open(sameContextUnbound, USER, ACCOUNT)).toThrow(DavSecretUnreadableError)
  })

  it('refuses a payload that decrypts but holds no secret', () => {
    const raw = new EmailDeliveryCipher(TEST_SERVER_KEY, DAV_ACCOUNT_SECRET_ENCRYPTION_CONTEXT)

    for (const payload of [{}, { secret: '' }, { secret: 7 }, null, 'text']) {
      expect(() => cipher.open(raw.encrypt(payload, [USER, ACCOUNT]), USER, ACCOUNT)).toThrow(DavSecretUnreadableError)
    }
  })

  it('says nothing about the failure or the secret in its errors', () => {
    const marker = sentinel('errors')
    const envelope = cipher.seal(new SecretString(marker.value), USER, ACCOUNT)
    let caught: unknown
    try {
      cipher.open(envelope, OTHER_USER, ACCOUNT)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(DavSecretUnreadableError)
    const rendered = `${String(caught)} ${JSON.stringify(caught)} ${inspect(caught, { depth: 10 })}`
    for (const window of marker.windows) {
      expect(rendered).not.toContain(window)
    }
    expect((caught as Error).message).toBe('The stored account secret could not be decrypted.')
    expect((caught as Error & { cause?: unknown }).cause).toBeUndefined()
  })

  it.each([
    ['no key', undefined],
    ['an empty key', ''],
    ['a key that is too short', 'abcd'],
    ['a key that is not hexadecimal', 'z'.repeat(64)],
  ])('is not ready with %s, and neither seals nor opens', (_label, key) => {
    const unready = new DavSecretCipher(key)
    const envelope = cipher.seal(new SecretString('app-password'), USER, ACCOUNT)

    expect(unready.isReady()).toBe(false)
    expect(() => unready.seal(new SecretString('app-password'), USER, ACCOUNT)).toThrow(DavSecretStoreUnavailableError)
    expect(() => unready.open(envelope, USER, ACCOUNT)).toThrow(DavSecretStoreUnavailableError)
  })

  it('is ready with a 64-character hexadecimal key, surrounding whitespace ignored', () => {
    expect(cipher.isReady()).toBe(true)
    expect(new DavSecretCipher(`  ${TEST_SERVER_KEY}\n`).isReady()).toBe(true)
  })
})

describe('EmailDeliveryCipher record binding', () => {
  const cipher = new EmailDeliveryCipher(TEST_SERVER_KEY)

  it('leaves unbound envelopes exactly as they were: sealed unbound, opened unbound', () => {
    const envelope = cipher.encrypt({ relays: [] })

    expect(cipher.decrypt(envelope)).toEqual({ relays: [] })
    expect(() => cipher.decrypt(envelope, [])).toThrow()
    expect(() => cipher.decrypt(envelope, ['x'])).toThrow()
  })

  it('opens a bound envelope only with the same parts in the same order', () => {
    const envelope = cipher.encrypt('value', ['user', 'account'])

    expect(cipher.decrypt(envelope, ['user', 'account'])).toBe('value')
    expect(() => cipher.decrypt(envelope)).toThrow()
    expect(() => cipher.decrypt(envelope, ['account', 'user'])).toThrow()
    expect(() => cipher.decrypt(envelope, ['user'])).toThrow()
    expect(() => cipher.decrypt(envelope, ['user', 'account', ''])).toThrow()
    expect(() => cipher.decrypt(envelope, ['user,account'])).toThrow()
    expect(() => cipher.decrypt(envelope, ['user","account'])).toThrow()
  })
})
