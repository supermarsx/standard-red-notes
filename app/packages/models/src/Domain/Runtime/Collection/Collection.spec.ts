import {
  Collection,
  DecryptedCollectionElement,
  DeletedCollectionElement,
  EncryptedCollectionElement,
} from './Collection'
import { FullyFormedPayloadInterface } from '../../Abstract/Payload'

class TestCollection<P extends FullyFormedPayloadInterface = FullyFormedPayloadInterface> extends Collection<
  P,
  DecryptedCollectionElement,
  EncryptedCollectionElement,
  DeletedCollectionElement
> {}

describe('Collection', () => {
  let collection: TestCollection

  beforeEach(() => {
    collection = new TestCollection()
  })

  it('should initialize correctly', () => {
    expect(collection.map).toEqual({})
    expect(collection.typedMap).toEqual({})
    expect(collection.referenceMap).toBeDefined()
    expect(collection.conflictMap).toBeDefined()
  })

  it('should set and get element correctly', () => {
    const testElement = {
      uuid: 'test-uuid',
      content_type: 'test-type',
      content: {},
      references: [],
    } as unknown as FullyFormedPayloadInterface

    collection.set(testElement)
    const element = collection.find('test-uuid')

    expect(element).toBe(testElement)
  })

  it('should check existence of an element correctly', () => {
    const testElement = {
      uuid: 'test-uuid',
      content_type: 'test-type',
      content: {},
      references: [],
    } as unknown as FullyFormedPayloadInterface

    collection.set(testElement)
    const hasElement = collection.has('test-uuid')

    expect(hasElement).toBe(true)
  })

  it('should return all elements', () => {
    const testElement1 = {
      uuid: 'test-uuid-1',
      content_type: 'test-type',
      content: {},
      references: [],
    } as unknown as FullyFormedPayloadInterface

    const testElement2 = {
      uuid: 'test-uuid-2',
      content_type: 'test-type',
      content: {},
      references: [],
    } as unknown as FullyFormedPayloadInterface

    collection.set(testElement1)
    collection.set(testElement2)

    const allElements = collection.all()

    expect(allElements).toEqual([testElement1, testElement2])
  })

  it('should add uuid to invalidsIndex if element is error decrypting', () => {
    const testElement = {
      uuid: 'test-uuid',
      content_type: 'test-type',
      content: 'encrypted content',
      errorDecrypting: true,
    } as unknown as FullyFormedPayloadInterface

    collection.set(testElement)

    expect(collection.invalidsIndex.has(testElement.uuid)).toBe(true)
  })

  it('should add uuid to invalidsIndex if element is encrypted', () => {
    const testElement = {
      uuid: 'test-uuid',
      content_type: 'test-type',
      content: 'encrypted content',
    } as unknown as FullyFormedPayloadInterface

    collection.set(testElement)

    expect(collection.invalidsIndex.has(testElement.uuid)).toBe(true)
  })

  it('should remove uuid from invalidsIndex if element is not encrypted', () => {
    const testElement1 = {
      uuid: 'test-uuid-1',
      content_type: 'test-type',
      content: 'encrypted content',
      errorDecrypting: true,
    } as unknown as FullyFormedPayloadInterface

    const testElement2 = {
      uuid: 'test-uuid-1',
      content_type: 'test-type',
      content: {},
      references: [],
    } as unknown as FullyFormedPayloadInterface

    collection.set(testElement1)
    expect(collection.invalidsIndex.has(testElement1.uuid)).toBe(true)

    collection.set(testElement2)
    expect(collection.invalidsIndex.has(testElement2.uuid)).toBe(false)
  })

  it('should insert N distinct uuids of one type with no duplicates', () => {
    const count = 1000
    const elements: FullyFormedPayloadInterface[] = []
    for (let i = 0; i < count; i++) {
      elements.push({
        uuid: `uuid-${i}`,
        content_type: 'test-type',
        content: {},
        references: [],
      } as unknown as FullyFormedPayloadInterface)
    }

    collection.set(elements)

    const typed = collection.all('test-type')
    expect(typed.length).toBe(count)

    const uuids = typed.map((e) => e.uuid)
    expect(new Set(uuids).size).toBe(count)
    expect(uuids).toEqual(elements.map((e) => e.uuid))
  })

  it('should replace (not duplicate) an existing uuid when re-set', () => {
    const original = {
      uuid: 'dup-uuid',
      content_type: 'test-type',
      content: { value: 'original' },
      references: [],
    } as unknown as FullyFormedPayloadInterface

    const updated = {
      uuid: 'dup-uuid',
      content_type: 'test-type',
      content: { value: 'updated' },
      references: [],
    } as unknown as FullyFormedPayloadInterface

    collection.set(original)
    collection.set(updated)

    const typed = collection.all('test-type')
    expect(typed.length).toBe(1)
    expect(typed[0]).toBe(updated)
  })

  it('should remove a discarded element from the typed map and presence set', () => {
    const testElement = {
      uuid: 'discard-uuid',
      content_type: 'test-type',
      content: {},
      references: [],
    } as unknown as FullyFormedPayloadInterface

    collection.set(testElement)
    expect(collection.all('test-type').length).toBe(1)

    collection.discard(testElement)
    expect(collection.all('test-type').length).toBe(0)

    /**
     * Re-inserting the same uuid after discard must still yield exactly one entry, proving
     * the presence set was cleared (a leaked presence entry would suppress the re-insert push
     * or, worse, leave a stale array element).
     */
    collection.set(testElement)
    const typed = collection.all('test-type')
    expect(typed.length).toBe(1)
    expect(typed[0]).toBe(testElement)
  })

  it('should not leave a uuid in two typed buckets when its content_type changes', () => {
    const original = {
      uuid: 'morphing-uuid',
      content_type: 'type-a',
      content: {},
      references: [],
    } as unknown as FullyFormedPayloadInterface

    const reTyped = {
      uuid: 'morphing-uuid',
      content_type: 'type-b',
      content: {},
      references: [],
    } as unknown as FullyFormedPayloadInterface

    collection.set(original)
    expect(collection.all('type-a').length).toBe(1)

    collection.set(reTyped)

    /** The old bucket must be emptied so the uuid does not live in two buckets simultaneously. */
    expect(collection.all('type-a').length).toBe(0)
    const typeB = collection.all('type-b')
    expect(typeB.length).toBe(1)
    expect(typeB[0]).toBe(reTyped)
  })
})
