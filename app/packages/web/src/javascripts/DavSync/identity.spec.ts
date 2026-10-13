/**
 * @jest-environment node
 */
import { createHash } from 'node:crypto'
import { isInboundId, localIdForUid, uidForEventId, uidForTodoId } from './identity'

/**
 * These answers are part of every linked calendar that exists. If one of them
 * has to change, the change is a migration of people's data, not an edit to
 * this file.
 */
const PINNED: [uid: string, localId: string][] = [
  ['6f6f0c56-0b0e-4b3c-9a52-0f6a3f6d3f11', 'dav-q7we7tr5efipmk2va4rx'],
  ['040000008200E00074C5B7101A82E00800000000B0A3C1E1D2F4DB01000000000000000010000000', 'dav-iv34r7qielammoqgwris'],
  ['event@example.org', 'dav-ppwltslscabrxn7ssvrk'],
  ['Ünïcödé — 日本語 😀', 'dav-o2fie3hj7vcflvtcofim'],
  ['', 'dav-4oymiquy7qobjgx36tej'],
]

/** RFC 4648 base32 of a digest, written out independently of the code under test. */
const independentId = (uid: string): string => {
  const digest = createHash('sha256').update(Buffer.from(uid, 'utf8')).digest()
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  const bits = [...digest].map((byte) => byte.toString(2).padStart(8, '0')).join('')
  let encoded = ''
  for (let at = 0; at + 5 <= bits.length; at += 5) {
    encoded += alphabet[parseInt(bits.slice(at, at + 5), 2)]
  }
  return `dav-${encoded.slice(0, 20)}`
}

describe('localIdForUid', () => {
  it.each(PINNED)('gives %j the id it has always had', (uid, localId) => {
    expect(localIdForUid(uid)).toBe(localId)
  })

  it.each(PINNED)('…which is the first 100 bits of the SHA-256 of %j in base32', (uid) => {
    expect(localIdForUid(uid)).toBe(independentId(uid))
  })

  it('is one id for one UID, and another for any other', () => {
    expect(localIdForUid('a')).toBe(localIdForUid('a'))
    const ids = new Set(['a', 'A', 'a ', ' a', 'a\n', 'b'].map(localIdForUid))
    expect(ids.size).toBe(6)
  })

  it('treats two spellings of one text as two UIDs, as a server does', () => {
    // Composed and decomposed "é" are different bytes, so a CalDAV server holds them as different entries.
    expect(localIdForUid('café')).not.toBe(localIdForUid('café'))
  })
})

describe('isInboundId', () => {
  it('recognises an id computed from a UID', () => {
    expect(isInboundId(localIdForUid('anything'))).toBe(true)
  })

  it('does not recognise ids the app makes itself, or near misses', () => {
    expect(isInboundId('evt-mfx1k2-1-a1b2c3')).toBe(false)
    expect(isInboundId('dav-')).toBe(false)
    expect(isInboundId('dav-q7we7tr5efipmk2va4r')).toBe(false)
    expect(isInboundId('dav-q7we7tr5efipmk2va4rxc')).toBe(false)
    expect(isInboundId('dav-Q7WE7TR5EFIPMK2VA4RX')).toBe(false)
    expect(isInboundId('dav-q7we7tr5efipmk2va4r1')).toBe(false)
    expect(isInboundId('xdav-q7we7tr5efipmk2va4rx')).toBe(false)
  })
})

describe('UIDs for entries made in the app', () => {
  it('are the entry id behind a fixed prefix', () => {
    expect(uidForEventId('evt-mfx1k2-1-a1b2c3')).toBe('srn-evt-mfx1k2-1-a1b2c3')
    expect(uidForTodoId('3f0c8d5e')).toBe('srn-task-3f0c8d5e')
  })
})
