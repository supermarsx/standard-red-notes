/**
 * @jest-environment node
 */
import { createHash } from 'node:crypto'
import { base32Lower, base64Url, sha256, utf8Bytes, utf8Length } from './sha256'

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')

/** A fixed sequence, so that a failure names the same input on every run. */
const sequence = (seed: number) => {
  let state = seed
  return (): number => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('sha256', () => {
  // FIPS 180-4 examples and the empty message.
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
  ])('digests %j to the published value', (message, digest) => {
    expect(hex(sha256(utf8Bytes(message)))).toBe(digest)
  })

  it('agrees with the platform for every length around the padding boundaries', () => {
    const next = sequence(1)
    let checked = 0
    for (let length = 0; length <= 260; length++) {
      const bytes = Uint8Array.from({ length }, () => Math.floor(next() * 256))
      expect(hex(sha256(bytes))).toBe(createHash('sha256').update(bytes).digest('hex'))
      checked += 1
    }
    expect(checked).toBe(261)
  })

  it('agrees with the platform for long inputs', () => {
    const next = sequence(2)
    for (const length of [1_000, 4_095, 4_096, 4_097, 65_537, 300_000]) {
      const bytes = Uint8Array.from({ length }, () => Math.floor(next() * 256))
      expect(hex(sha256(bytes))).toBe(createHash('sha256').update(bytes).digest('hex'))
    }
  })

  it('does not change the bytes it is given', () => {
    const bytes = Uint8Array.from([1, 2, 3, 4])
    sha256(bytes)
    expect([...bytes]).toEqual([1, 2, 3, 4])
  })
})

describe('utf8Bytes', () => {
  it('encodes text as UTF-8, astral characters included', () => {
    expect(hex(utf8Bytes('é€😀'))).toBe('c3a9e282acf09f9880')
  })

  it('turns half of a surrogate pair into the replacement character, wherever it stands', () => {
    expect(hex(utf8Bytes('a\ud83d'))).toBe('61efbfbd')
    expect(hex(utf8Bytes('\ud83db'))).toBe('efbfbd62')
    expect(hex(utf8Bytes('\ude00\ud83d'))).toBe('efbfbdefbfbd')
  })

  it('agrees with the platform encoder on text of every kind, and on its length', () => {
    const next = sequence(4)
    // The edges of each encoded length, both halves of the surrogate range, and the last code point.
    const edges = [
      0, 0x7f, 0x80, 0x7ff, 0x800, 0xd7ff, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xe000, 0xffff, 0x10000, 0x10ffff,
    ]
    const anyCharacter = (): string => {
      const pick = next()
      if (pick < 0.3) {
        return String.fromCodePoint(edges[Math.floor(next() * edges.length)])
      }
      if (pick < 0.4) {
        return String.fromCharCode(0xd800 + Math.floor(next() * 0x800))
      }
      return String.fromCodePoint(Math.floor(next() * 0x3000))
    }
    let checked = 0
    let withLoneSurrogate = 0
    for (let round = 0; round < 500; round++) {
      const text = Array.from({ length: Math.floor(next() * 40) }, anyCharacter).join('')
      const expected = new TextEncoder().encode(text)
      expect(hex(utf8Bytes(text))).toBe(hex(expected))
      expect(utf8Length(text)).toBe(expected.length)
      checked += 1
      withLoneSurrogate += /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text) ? 1 : 0
    }
    expect(checked).toBe(500)
    // The awkward case really was among them.
    expect(withLoneSurrogate).toBeGreaterThan(100)
  })
})

describe('base32Lower', () => {
  // RFC 4648 section 10, lower-cased and without padding.
  it.each([
    ['', ''],
    ['f', 'my'],
    ['fo', 'mzxq'],
    ['foo', 'mzxw6'],
    ['foob', 'mzxw6yq'],
    ['fooba', 'mzxw6ytb'],
    ['foobar', 'mzxw6ytboi'],
  ])('encodes %j as %j', (text, encoded) => {
    expect(base32Lower(utf8Bytes(text))).toBe(encoded)
  })

  it('uses every one of its 32 characters', () => {
    const all = Uint8Array.from({ length: 256 }, (_, index) => index)
    expect(new Set(base32Lower(all)).size).toBe(32)
  })
})

describe('base64Url', () => {
  it('agrees with the platform for every length up to 64 and for all byte values', () => {
    const next = sequence(3)
    for (let length = 0; length <= 64; length++) {
      const bytes = Uint8Array.from({ length }, () => Math.floor(next() * 256))
      expect(base64Url(bytes)).toBe(Buffer.from(bytes).toString('base64url'))
    }
    const all = Uint8Array.from({ length: 256 }, (_, index) => index)
    expect(base64Url(all)).toBe(Buffer.from(all).toString('base64url'))
  })
})
