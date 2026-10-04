import { ContentType } from '@standardnotes/domain-core'
import { DecryptedPayload } from '../../Abstract/Payload/Implementations/DecryptedPayload'
import { PayloadSource } from '../../Abstract/Payload/Types/PayloadSource'
import { PayloadTimestampDefaults } from '../../Abstract/Payload'
import { FillItemContent } from '../../Abstract/Content/ItemContent'
import { MutationType } from '../../Abstract/Item'
import { FolderContent } from './FolderContent'
import { FolderContentType } from './FolderContentType'
import { FolderMutator } from './FolderMutator'
import { SNFolder } from './SNFolder'

/**
 * `hidden` keeps a folder's row out of the client's navigation sidebar, and the client takes
 * the folder's subtree with it. It is presentation only: nothing here changes what the folder
 * references, and the item keeps syncing exactly as before. These cases pin the model's half
 * of that — faithful reporting, absent meaning shown, and "shown" having a single
 * representation after a round trip through the mutator.
 */
const createFolder = (content: Partial<FolderContent>): SNFolder => {
  return new SNFolder(
    new DecryptedPayload(
      {
        uuid: String(Math.random()),
        content_type: FolderContentType,
        content: FillItemContent<FolderContent>(content),
        ...PayloadTimestampDefaults(),
      },
      PayloadSource.Constructor,
    ),
  )
}

describe('SNFolder hidden', () => {
  it('is false when the content carries no flag', () => {
    expect(createFolder({ title: 'Receipts' }).hidden).toBe(false)
  })

  it('is true when the content says so', () => {
    expect(createFolder({ title: 'Receipts', hidden: true }).hidden).toBe(true)
  })

  it('is false for an explicit false rather than merely truthy-checking it', () => {
    expect(createFolder({ title: 'Receipts', hidden: false }).hidden).toBe(false)
  })

  it('does not touch what the folder references', () => {
    const folder = createFolder({
      title: 'Receipts',
      hidden: true,
      references: [{ uuid: 'note-1', content_type: ContentType.TYPES.Note }],
    })

    expect(folder.noteCount).toEqual(1)
  })
})

describe('FolderMutator hidden', () => {
  it('writes the flag when hiding', () => {
    const folder = createFolder({ title: 'Receipts' })
    const mutator = new FolderMutator(folder, MutationType.UpdateUserTimestamps)
    mutator.hidden = true

    expect(mutator.getResult().content.hidden).toBe(true)
  })

  it('removes the key when showing again', () => {
    const folder = createFolder({ title: 'Receipts', hidden: true })
    const mutator = new FolderMutator(folder, MutationType.UpdateUserTimestamps)
    mutator.hidden = false

    expect('hidden' in mutator.getResult().content).toBe(false)
    expect(new SNFolder(mutator.getResult()).hidden).toBe(false)
  })

  it('keeps the parent reference a hidden folder already had', () => {
    const parent = createFolder({ title: 'Finance' })
    const child = createFolder({ title: 'Receipts', hidden: true })

    const mutator = new FolderMutator(child, MutationType.UpdateUserTimestamps)
    mutator.makeChildOf(parent)
    const result = new SNFolder(mutator.getResult())

    expect(result.hidden).toBe(true)
    expect(result.parentId).toEqual(parent.uuid)
  })
})
