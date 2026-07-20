import { ConflictType } from './ConflictType'
import {
  conflictParamsHasOnlyServerItem,
  conflictParamsHasOnlyUnsavedItem,
  conflictParamsHasServerItemAndUnsavedItem,
} from './ConflictParams'

type Item = { uuid: string }

const serverItem: Item = { uuid: 'server' }
const unsavedItem: Item = { uuid: 'unsaved' }

describe('ConflictParams', () => {
  describe('conflictParamsHasServerItemAndUnsavedItem', () => {
    it('should be true only when both items are present', () => {
      expect(
        conflictParamsHasServerItemAndUnsavedItem<Item>({
          type: ConflictType.ReadOnlyError,
          server_item: serverItem,
          unsaved_item: unsavedItem,
        }),
      ).toBe(true)
    })

    it('should be false when only the server item is present', () => {
      expect(
        conflictParamsHasServerItemAndUnsavedItem<Item>({
          type: ConflictType.ConflictingData,
          server_item: serverItem,
        }),
      ).toBe(false)
    })

    it('should be false when only the unsaved item is present', () => {
      expect(
        conflictParamsHasServerItemAndUnsavedItem<Item>({
          type: ConflictType.UuidConflict,
          unsaved_item: unsavedItem,
        }),
      ).toBe(false)
    })

    it('should be false when neither item is present', () => {
      expect(conflictParamsHasServerItemAndUnsavedItem<Item>({ type: ConflictType.InvalidServerItem })).toBe(false)
    })
  })

  describe('conflictParamsHasOnlyServerItem', () => {
    it('should be true when the server item is present', () => {
      expect(
        conflictParamsHasOnlyServerItem<Item>({ type: ConflictType.ConflictingData, server_item: serverItem }),
      ).toBe(true)
    })

    it('should be false when the server item is absent', () => {
      expect(
        conflictParamsHasOnlyServerItem<Item>({ type: ConflictType.UuidConflict, unsaved_item: unsavedItem }),
      ).toBe(false)
    })
  })

  describe('conflictParamsHasOnlyUnsavedItem', () => {
    it('should be true when the unsaved item is present', () => {
      expect(
        conflictParamsHasOnlyUnsavedItem<Item>({ type: ConflictType.UuidConflict, unsaved_item: unsavedItem }),
      ).toBe(true)
    })

    it('should be false when the unsaved item is absent', () => {
      expect(
        conflictParamsHasOnlyUnsavedItem<Item>({ type: ConflictType.ConflictingData, server_item: serverItem }),
      ).toBe(false)
    })
  })
})
