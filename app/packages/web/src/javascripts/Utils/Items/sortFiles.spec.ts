import { FileItem } from '@standardnotes/snjs'
import { sortFiles } from './sortFiles'

/**
 * sortFiles only reads `name`, `decryptedSize` and `created_at`, so the tests use
 * lightweight stand-ins cast to FileItem rather than constructing full payloads.
 */
const makeFile = (uuid: string, name: string, size: number, createdAtMs: number): FileItem =>
  ({
    uuid,
    name,
    decryptedSize: size,
    created_at: new Date(createdAtMs),
  } as unknown as FileItem)

const uuids = (files: FileItem[]) => files.map((file) => file.uuid)

describe('sortFiles', () => {
  // Intentionally unordered so each sort has something to do.
  const a = makeFile('a', 'banana', 300, 2_000)
  const b = makeFile('b', 'apple', 100, 1_000)
  const c = makeFile('c', 'cherry', 200, 3_000)

  const files = [a, b, c]

  it('does not mutate the input array', () => {
    const input = [...files]
    sortFiles(input, 'name', 'asc')
    expect(input).toEqual([a, b, c])
  })

  describe('name', () => {
    it('sorts ascending alphabetically', () => {
      expect(uuids(sortFiles(files, 'name', 'asc'))).toEqual(['b', 'a', 'c'])
    })

    it('sorts descending alphabetically', () => {
      expect(uuids(sortFiles(files, 'name', 'dsc'))).toEqual(['c', 'a', 'b'])
    })
  })

  describe('size', () => {
    it('sorts ascending by decrypted size', () => {
      expect(uuids(sortFiles(files, 'size', 'asc'))).toEqual(['b', 'c', 'a'])
    })

    it('sorts descending by decrypted size', () => {
      expect(uuids(sortFiles(files, 'size', 'dsc'))).toEqual(['a', 'c', 'b'])
    })
  })

  describe('date', () => {
    it('sorts ascending by created_at', () => {
      expect(uuids(sortFiles(files, 'date', 'asc'))).toEqual(['b', 'a', 'c'])
    })

    it('sorts descending by created_at', () => {
      expect(uuids(sortFiles(files, 'date', 'dsc'))).toEqual(['c', 'a', 'b'])
    })
  })

  describe('stability for equal keys', () => {
    // Three files with the SAME sort key must keep their original relative order.
    const x = makeFile('x', 'same', 50, 5_000)
    const y = makeFile('y', 'same', 50, 5_000)
    const z = makeFile('z', 'same', 50, 5_000)
    const equal = [x, y, z]

    it('is stable for equal names (asc and dsc)', () => {
      expect(uuids(sortFiles(equal, 'name', 'asc'))).toEqual(['x', 'y', 'z'])
      expect(uuids(sortFiles(equal, 'name', 'dsc'))).toEqual(['x', 'y', 'z'])
    })

    it('is stable for equal sizes', () => {
      expect(uuids(sortFiles(equal, 'size', 'asc'))).toEqual(['x', 'y', 'z'])
    })

    it('is stable for equal dates', () => {
      expect(uuids(sortFiles(equal, 'date', 'dsc'))).toEqual(['x', 'y', 'z'])
    })
  })
})
