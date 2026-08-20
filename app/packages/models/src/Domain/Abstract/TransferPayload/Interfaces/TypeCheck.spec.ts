import { ContentType } from '@standardnotes/domain-core'
import { PayloadTimestampDefaults } from '../../Payload'
import { FolderContentType } from '../../../Syncable/Folder/FolderContentType'
import { isCorruptTransferPayload } from './TypeCheck'

describe('type check', () => {
  describe('isCorruptTransferPayload', () => {
    it('should return false if is valid', () => {
      expect(
        isCorruptTransferPayload({
          uuid: '123',
          content_type: ContentType.TYPES.Note,
          content: '123',
          ...PayloadTimestampDefaults(),
        }),
      ).toBe(false)
    })

    it('should return true if uuid is missing', () => {
      expect(
        isCorruptTransferPayload({
          uuid: undefined as never,
          content_type: ContentType.TYPES.Note,
          content: '123',
          ...PayloadTimestampDefaults(),
        }),
      ).toBe(true)
    })

    it('should return true if is deleted but has content', () => {
      expect(
        isCorruptTransferPayload({
          uuid: '123',
          content_type: ContentType.TYPES.Note,
          content: '123',
          deleted: true,
          ...PayloadTimestampDefaults(),
        }),
      ).toBe(true)
    })

    it('should not treat a folder arriving from the server as corrupt', () => {
      /**
       * The pinned domain-core build does not enumerate 'Folder', so validating against it alone
       * discards every folder the server returns. The folder then never reaches local item state,
       * which duplicates it on the next create and mismatches on every integrity check.
       */
      expect(ContentType.create(FolderContentType).isFailed()).toBe(true)
      expect(
        isCorruptTransferPayload({
          uuid: '123',
          content_type: FolderContentType,
          content: '123',
          ...PayloadTimestampDefaults(),
        }),
      ).toBe(false)
    })

    it('should still reject a deleted folder that carries content', () => {
      expect(
        isCorruptTransferPayload({
          uuid: '123',
          content_type: FolderContentType,
          content: '123',
          deleted: true,
          ...PayloadTimestampDefaults(),
        }),
      ).toBe(true)
    })

    it('should return true if content type is unknown', () => {
      expect(
        isCorruptTransferPayload({
          uuid: '123',
          content_type: 'Unknown',
          content: '123',
          ...PayloadTimestampDefaults(),
        }),
      ).toBe(true)
    })
  })
})
