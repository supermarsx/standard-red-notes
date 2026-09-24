import { ContentType } from '@standardnotes/domain-core'
import { FillItemContent, ItemContent } from '../../Abstract/Content/ItemContent'
import { DecryptedPayload, PayloadTimestampDefaults } from '../../Abstract/Payload'
import { CreateDecryptedItemFromPayload } from '../../Utilities/Item/ItemGenerator'
import { SNNote } from '../../Syncable/Note'
import { BuildSmartViews } from '../../Syncable/SmartView/SmartViewBuilder'
import { SmartView } from '../../Syncable/SmartView/SmartView'
import { SmartViewContent } from '../../Syncable/SmartView/SmartViewContent'
import { SystemViewId } from '../../Syncable/SmartView/SystemViewId'
import { NotesAndFilesDisplayOptions } from './DisplayOptions'
import { notesAndFilesMatchingOptions } from './DisplayOptionsToFilters'
import { ReferenceLookupCollection, SearchableDecryptedItem } from './Search/Types'

/**
 * The "Conflicts" system view used to show the exact inverse of its name: every ordinary
 * note, and none of the conflicted copies. Two things combined to cause it —
 * computeFiltersForDisplayOptions applies a blanket `!item.conflictOf` filter unless the
 * active view's predicate mentions `conflict_of`, and conflictsPredicate never mentioned it,
 * so the view both inherited the hide-conflicts filter and had no clause selecting conflicted
 * copies. The sidebar entry meanwhile shows a live conflict count, so a user could see
 * "Conflicts 1", click it, and be shown all of their other notes instead.
 */
const makeNote = (uuid: string, title: string, conflictOf?: string) =>
  CreateDecryptedItemFromPayload(
    new DecryptedPayload({
      uuid,
      content_type: ContentType.TYPES.Note,
      content: FillItemContent({
        title,
        text: 'body',
        ...(conflictOf ? { conflict_of: conflictOf } : {}),
      } as Partial<ItemContent>),
      ...PayloadTimestampDefaults(),
      updated_at_timestamp: 1,
    }),
  ) as unknown as SNNote

const collection = {
  elementsReferencingElement: () => [],
} as unknown as ReferenceLookupCollection

const baseOptions: NotesAndFilesDisplayOptions = {
  includePinned: true,
  includeProtected: true,
  includeTrashed: false,
  includeArchived: false,
}

const viewById = (id: SystemViewId) => BuildSmartViews(baseOptions).find((view) => view.uuid === id)!

const shownIn = (id: SystemViewId, items: SNNote[]) =>
  notesAndFilesMatchingOptions(
    { ...baseOptions, views: [viewById(id)] },
    items as unknown as SearchableDecryptedItem[],
    collection,
  ).map((item) => item.uuid)

describe('system view filtering of conflicted copies', () => {
  const plain = makeNote('plain-uuid', 'An ordinary note')
  const copy = makeNote('copy-uuid', 'A conflicted copy', 'original-uuid')

  describe('the Conflicts view', () => {
    it('shows the conflicted copy', () => {
      expect(shownIn(SystemViewId.Conflicts, [plain, copy])).toContain('copy-uuid')
    })

    it('shows ONLY conflicted copies, not ordinary notes', () => {
      expect(shownIn(SystemViewId.Conflicts, [plain, copy])).toEqual(['copy-uuid'])
    })

    it('is empty when nothing is conflicted', () => {
      expect(shownIn(SystemViewId.Conflicts, [plain])).toEqual([])
    })

    it('selects on the conflict relationship rather than on note fields alone', () => {
      expect(viewById(SystemViewId.Conflicts).predicate.keypathIncludesString('conflictOf')).toBe(true)
    })
  })

  describe('REGRESSION: every other view still hides conflicted copies', () => {
    it('keeps them out of the all-notes list', () => {
      expect(shownIn(SystemViewId.AllNotes, [plain, copy])).toEqual(['plain-uuid'])
    })

    it('keeps them out of the starred list', () => {
      expect(shownIn(SystemViewId.StarredNotes, [plain, copy])).not.toContain('copy-uuid')
    })

    it('keeps them out of the untagged list', () => {
      expect(shownIn(SystemViewId.UntaggedNotes, [plain, copy])).not.toContain('copy-uuid')
    })

    it('leaves the all-notes predicate free of any conflict clause', () => {
      expect(viewById(SystemViewId.AllNotes).predicate.keypathIncludesString('conflictOf')).toBe(false)
    })

    it('still honours a user-authored smart view whose predicate names conflict_of', () => {
      // The pre-existing escape hatch for custom smart views must survive the
      // uuid-based exemption added for the Conflicts view.
      const custom = new SmartView(
        new DecryptedPayload<SmartViewContent>({
          uuid: 'custom-view-uuid',
          content_type: ContentType.TYPES.SmartView,
          ...PayloadTimestampDefaults(),
          content: FillItemContent<SmartViewContent>({
            title: 'My conflicts',
            predicate: { keypath: 'content.conflict_of', operator: '!=', value: '' },
          }),
        }),
      )

      const shown = notesAndFilesMatchingOptions(
        { ...baseOptions, views: [custom] },
        [plain, copy] as unknown as SearchableDecryptedItem[],
        collection,
      ).map((item) => item.uuid)

      expect(shown).toEqual(['copy-uuid'])
    })
  })
})
