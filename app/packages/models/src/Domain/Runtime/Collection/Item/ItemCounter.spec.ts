import { SNFolder, FolderContent, FolderContentType } from '../../../Syncable/Folder'
import { ContentReferenceType } from '../../../Abstract/Reference/ContenteReferenceType'
import { TagContent } from '../../../Syncable/Tag/TagContent'
import { SNTag } from '../../../Syncable/Tag/Tag'
import { VaultDisplayOptions } from '../../Display/VaultDisplayOptions'
import { ItemCounter } from './ItemCounter'
import { NoteContent } from '../../../Syncable/Note/NoteContent'
import { ContentType } from '@standardnotes/domain-core'
import { DecryptedItem, EncryptedItem, DeletedItem } from '../../../Abstract/Item'
import { DecryptedPayload, EncryptedPayload, DeletedPayload, PayloadTimestampDefaults } from '../../../Abstract/Payload'
import { ItemCollection } from './ItemCollection'
import { FillItemContent } from '../../../Abstract/Content/ItemContent'
import { ItemDelta } from '../../Index/ItemDelta'
import { AnyItemInterface } from '../../../Abstract/Item/Interfaces/UnionTypes'

describe('tag notes index', () => {
  const createEncryptedItem = (uuid?: string) => {
    const payload = new EncryptedPayload({
      uuid: uuid || String(Math.random()),
      content_type: ContentType.TYPES.Note,
      content: '004:...',
      enc_item_key: '004:...',
      items_key_id: '123',
      waitingForKey: true,
      errorDecrypting: true,
      ...PayloadTimestampDefaults(),
    })

    return new EncryptedItem(payload)
  }

  const createDecryptedItem = (uuid?: string, content_type = ContentType.TYPES.Note) => {
    const payload = new DecryptedPayload({
      uuid: uuid || String(Math.random()),
      content_type,
      content: FillItemContent<NoteContent>({
        title: 'foo',
      }),
      ...PayloadTimestampDefaults(),
    })
    return new DecryptedItem(payload)
  }

  const createChangeDelta = (item: AnyItemInterface): ItemDelta => {
    return {
      changed: [item],
      inserted: [],
      discarded: [],
      ignored: [],
      unerrored: [],
    }
  }

  it('should count both notes and files', () => {
    const collection = new ItemCollection()
    const index = new ItemCounter(collection)

    const decryptedNote = createDecryptedItem('note')
    const decryptedFile = createDecryptedItem('file')
    collection.set([decryptedNote, decryptedFile])
    index.onChange(createChangeDelta(decryptedNote))
    index.onChange(createChangeDelta(decryptedFile))

    expect(index.allCountableItemsCount()).toEqual(2)
  })

  it('should decrement count after decrypted note becomes errored', () => {
    const collection = new ItemCollection()
    const index = new ItemCounter(collection)

    const decryptedItem = createDecryptedItem()
    collection.set(decryptedItem)
    index.onChange(createChangeDelta(decryptedItem))

    expect(index.allCountableItemsCount()).toEqual(1)

    const encryptedItem = createEncryptedItem(decryptedItem.uuid)
    collection.set(encryptedItem)
    index.onChange(createChangeDelta(encryptedItem))

    expect(index.allCountableItemsCount()).toEqual(0)
  })
})

describe('count notifications after deletion and scope changes', () => {
  const note = (uuid: string, vault?: string) =>
    new DecryptedItem(
      new DecryptedPayload({
        uuid,
        content_type: ContentType.TYPES.Note,
        key_system_identifier: vault,
        content: FillItemContent<NoteContent>({ title: uuid }),
        ...PayloadTimestampDefaults(),
      }),
    )
  const deleted = (uuid: string) =>
    new DeletedItem(
      new DeletedPayload({
        uuid,
        content_type: ContentType.TYPES.Note,
        content: undefined,
        deleted: true,
        ...PayloadTimestampDefaults(),
      }),
    )
  const apply = (collection: ItemCollection, counter: ItemCounter, delta: Partial<ItemDelta>) => {
    const full = { changed: [], inserted: [], discarded: [], ignored: [], unerrored: [], ...delta }
    collection.onChange(full)
    counter.onChange(full)
  }

  it('removes cached tag membership when remote clean tombstones discard reverse references first', () => {
    const collection = new ItemCollection()
    const counter = new ItemCounter(collection)
    const item = note('removed')
    const tag = new SNTag(
      new DecryptedPayload({
        uuid: 'tag',
        content_type: ContentType.TYPES.Tag,
        content: FillItemContent<TagContent>({
          title: 'tag',
          references: [{ uuid: item.uuid, content_type: item.content_type }],
        }),
        ...PayloadTimestampDefaults(),
      }),
    )
    apply(collection, counter, { inserted: [item, tag] })
    expect(counter.countableItemsForTag(tag)).toBe(1)
    const observed = jest.fn()
    counter.addCountChangeObserver(observed)
    apply(collection, counter, { discarded: [deleted(item.uuid)] })
    expect(collection.uuidsThatReferenceUuid(item.uuid)).toEqual([])
    expect(counter.countableItemsForTag(tag)).toBe(0)
    expect(counter.allCountableNotesCount()).toBe(0)
    expect(observed).toHaveBeenCalledWith(tag.uuid)
    expect(observed).toHaveBeenCalledWith(undefined)
    // A repeated tombstone is idempotent, with no spurious count changes.
    observed.mockClear()
    apply(collection, counter, { discarded: [deleted(item.uuid)] })
    expect(observed).not.toHaveBeenCalled()
  })

  it('notifies a changed note/file count even when a mixed batch leaves the combined total unchanged', () => {
    const collection = new ItemCollection()
    const counter = new ItemCounter(collection)
    apply(collection, counter, { inserted: [note('old-note')] })
    const observed = jest.fn()
    counter.addCountChangeObserver(observed)
    const file = new DecryptedItem(
      new DecryptedPayload({
        uuid: 'new-file',
        content_type: ContentType.TYPES.File,
        content: FillItemContent({}),
        ...PayloadTimestampDefaults(),
      }),
    )
    apply(collection, counter, { discarded: [deleted('old-note')], inserted: [file] })
    expect(counter.allCountableItemsCount()).toBe(1)
    expect(counter.allCountableNotesCount()).toBe(0)
    expect(counter.allCountableFilesCount()).toBe(1)
    expect(observed).toHaveBeenCalledTimes(1)
    expect(observed).toHaveBeenCalledWith(undefined)
  })

  it('keeps exclusive/locked vault counts scoped through deletion and switches', () => {
    const collection = new ItemCollection()
    const counter = new ItemCounter(collection)
    apply(collection, counter, { inserted: [note('personal'), note('a', 'vault-a'), note('b', 'vault-b')] })
    counter.setVaultDisplayOptions(new VaultDisplayOptions({ exclusive: 'vault-a' }))
    expect(counter.allCountableNotesCount()).toBe(1)
    const observed = jest.fn()
    counter.addCountChangeObserver(observed)
    apply(collection, counter, { discarded: [deleted('b')] })
    expect(counter.allCountableNotesCount()).toBe(1)
    expect(observed).not.toHaveBeenCalled()
    apply(collection, counter, { discarded: [deleted('a')] })
    expect(counter.allCountableNotesCount()).toBe(0)
    expect(observed).toHaveBeenCalledWith(undefined)
    counter.setVaultDisplayOptions(new VaultDisplayOptions({ exclude: [], locked: ['vault-a'] }))
    expect(counter.allCountableNotesCount()).toBe(1)
    counter.setDisplayOptions({ customFilter: () => false })
    expect(counter.allCountableNotesCount()).toBe(0)
  })

  it('keeps direct and ancestor folder counts unique, scoped, and live through trash/restoration/remote discard', () => {
    const collection = new ItemCollection()
    const counter = new ItemCounter(collection)
    const folder = (uuid: string, notes: string[], parent?: string) =>
      new SNFolder(
        new DecryptedPayload({
          uuid,
          content_type: FolderContentType,
          content: FillItemContent<FolderContent>({
            title: uuid,
            references: [
              ...notes.map((uuid) => ({ uuid, content_type: ContentType.TYPES.Note })),
              ...(parent
                ? [
                    {
                      uuid: parent,
                      content_type: FolderContentType,
                      reference_type: ContentReferenceType.FolderToParentFolder as const,
                    },
                  ]
                : []),
            ],
          }),
          ...PayloadTimestampDefaults(),
        }),
      )
    const parent = folder('parent', ['shared'])
    const child = folder('child', ['shared', 'child-only', 'missing', 'excluded'], parent.uuid)
    const other = folder('other', [])
    const shared = note('shared', 'vault-a')
    const childNote = note('child-only', 'vault-a')
    apply(collection, counter, { inserted: [shared, childNote, note('excluded', 'vault-b'), parent, child, other] })
    counter.setVaultDisplayOptions(new VaultDisplayOptions({ exclusive: 'vault-a' }))
    expect(counter.countableNotesForFolder(parent, false)).toBe(1)
    expect(counter.countableNotesForFolder(child, false)).toBe(2)
    expect(counter.countableNotesForFolder(parent, true)).toBe(2)
    const observed = jest.fn()
    counter.addCountChangeObserver(observed)
    const trashed = new DecryptedItem(
      childNote.payloadRepresentation().copy({ content: FillItemContent<NoteContent>({ trashed: true }) }),
    )
    apply(collection, counter, { changed: [trashed] })
    expect(counter.countableNotesForFolder(child)).toBe(1)
    expect(counter.countableNotesForFolder(parent, true)).toBe(1)
    expect(observed).toHaveBeenCalledWith(parent.uuid)
    apply(collection, counter, { changed: [childNote] })
    expect(counter.countableNotesForFolder(parent, true)).toBe(2)
    apply(collection, counter, { discarded: [deleted(shared.uuid)] })
    expect(counter.countableNotesForFolder(parent, false)).toBe(0)
    expect(counter.countableNotesForFolder(child)).toBe(1)
    expect(counter.countableNotesForFolder(parent, true)).toBe(1)
    // Reparenting moves the aggregate; stale parent references do not count missing notes.
    apply(collection, counter, { changed: [folder(child.uuid, ['child-only'], other.uuid)] })
    expect(counter.countableNotesForFolder(parent, true)).toBe(0)
    expect(counter.countableNotesForFolder(other, true)).toBe(1)
    expect(observed).toHaveBeenCalledWith(other.uuid)
  })

  it('bounds malformed folder ancestry cycles and excludes file references from note badges', () => {
    const collection = new ItemCollection()
    const counter = new ItemCounter(collection)
    const folder = (uuid: string, parent: string) =>
      new SNFolder(
        new DecryptedPayload({
          uuid,
          content_type: FolderContentType,
          content: FillItemContent<FolderContent>({
            title: uuid,
            references: [
              {
                uuid: parent,
                content_type: FolderContentType,
                reference_type: ContentReferenceType.FolderToParentFolder as const,
              },
              { uuid: 'note', content_type: ContentType.TYPES.Note },
              { uuid: 'file', content_type: ContentType.TYPES.File },
            ],
          }),
          ...PayloadTimestampDefaults(),
        }),
      )
    const a = folder('a', 'b'),
      b = folder('b', 'a')
    const file = new DecryptedItem(
      new DecryptedPayload({
        uuid: 'file',
        content_type: ContentType.TYPES.File,
        content: FillItemContent({}),
        ...PayloadTimestampDefaults(),
      }),
    )
    apply(collection, counter, { inserted: [note('note'), file, a, b] })
    counter.setDisplayOptions({})
    expect(counter.allCountableItemsCount()).toBe(2)
    expect(counter.countableNotesForFolder(a, true)).toBe(1)
    expect(counter.countableNotesForFolder(b, true)).toBe(1)
    apply(collection, counter, {
      discarded: [
        new DeletedItem(
          new DeletedPayload({
            uuid: a.uuid,
            content_type: FolderContentType,
            deleted: true,
            content: undefined,
            ...PayloadTimestampDefaults(),
          }),
        ),
      ],
    })
    expect(counter.countableNotesForFolder(a)).toBe(0)
  })
})
