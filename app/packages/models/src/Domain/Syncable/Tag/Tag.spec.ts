import { PayloadSource } from './../../Abstract/Payload/Types/PayloadSource'
import { DecryptedPayload } from './../../Abstract/Payload/Implementations/DecryptedPayload'
import { SNTag } from './Tag'
import { ContentType } from '@standardnotes/domain-core'
import { FillItemContent } from '../../Abstract/Content/ItemContent'
import { ContentReference } from '../../Abstract/Reference/ContentReference'
import { PayloadTimestampDefaults } from '../../Abstract/Payload'
import { TagContent } from './TagContent'
import { createTagWithContent } from '../../Utilities/Test/SpecUtils'

const randUuid = () => String(Math.random())

const create = (title: string, references: ContentReference[] = []): SNTag => {
  const tag = new SNTag(
    new DecryptedPayload(
      {
        uuid: randUuid(),
        content_type: ContentType.TYPES.Tag,
        content: FillItemContent({
          title,
          references,
        } as TagContent),
        ...PayloadTimestampDefaults(),
      },
      PayloadSource.Constructor,
    ),
  )

  return tag
}

describe('SNTag Tests', () => {
  it('should count notes in the basic case', () => {
    const tag = create('helloworld', [
      { uuid: randUuid(), content_type: ContentType.TYPES.Note },
      { uuid: randUuid(), content_type: ContentType.TYPES.Note },
      { uuid: randUuid(), content_type: ContentType.TYPES.Tag },
    ])

    expect(tag.noteCount).toEqual(2)
  })

  it('preferences should be undefined if not specified', () => {
    const tag = create('helloworld', [])

    expect(tag.preferences).toBeFalsy()
  })

  /**
   * `hidden` keeps a tag's row out of the client's navigation sidebar. It is presentation
   * only — nothing here changes what the tag references or whether it syncs — so the model's
   * only job is to report the flag faithfully, with absent meaning shown.
   */
  describe('hidden', () => {
    it('is false when the content carries no flag', () => {
      expect(create('helloworld', []).hidden).toBe(false)
    })

    it('is true when the content says so', () => {
      expect(createTagWithContent({ title: 'helloworld', hidden: true }).hidden).toBe(true)
    })

    it('is false for an explicit false rather than merely truthy-checking it', () => {
      expect(createTagWithContent({ title: 'helloworld', hidden: false }).hidden).toBe(false)
    })

    it('does not touch what the tag references', () => {
      const tag = createTagWithContent({
        title: 'helloworld',
        hidden: true,
        references: [{ uuid: randUuid(), content_type: ContentType.TYPES.Note }],
      })

      expect(tag.noteCount).toEqual(1)
    })
  })
})
