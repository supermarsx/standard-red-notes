import { ContentType } from '@standardnotes/domain-core'
import { UuidGenerator } from '@standardnotes/utils'
import { FillItemContent, ItemContent } from '../../Abstract/Content/ItemContent'
import { ConflictStrategy } from '../../Abstract/Item'
import { AppDataField } from '../../Abstract/Item/Types/AppDataField'
import { DefaultAppDomain } from '../../Abstract/Item/Types/DefaultAppDomain'
import {
  DecryptedPayload,
  FullyFormedPayloadInterface,
  isDecryptedPayload,
  PayloadTimestampDefaults,
} from '../../Abstract/Payload'
import { ImmutablePayloadCollection } from '../Collection/Payload/ImmutablePayloadCollection'
import { PayloadCollection } from '../Collection/Payload/PayloadCollection'
import { HistoryMap } from '../History'
import { ConflictDelta } from './Conflict'

UuidGenerator.SetGenerator(() => String(Math.random()))

/**
 * A note edited in a live shared document is saved by every person in the room, and each save
 * carries a stamp saying which state of the document its body is. Two people saving the SAME
 * body a moment apart write different stamps. Before stamps existed that race resolved quietly
 * (equal content: keep the server's); if the stamp counted as content it would instead leave a
 * conflicted copy of a note whose two versions say exactly the same thing.
 *
 * So the stamp, and only the stamp, is left out of the comparison. Everything else about how an
 * item conflicts is as it was, and an item that carries no stamp takes the path it always took.
 */
describe('the collaboration stamp is not part of what a note says', () => {
  const historyMap = {} as HistoryMap
  const uuid = 'note-uuid'
  /** Long enough ago that the "actively editing" rule does not pick the strategy. */
  const longAgo = new Date(Date.now() - 60 * 60 * 1000)

  const stamp = (clock: number) => ({
    v: 1,
    epoch: '5f0c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f',
    sv: [[11, clock]],
    text: [4, 'abcd'],
  })

  const note = (content: { text: string; domain?: Record<string, unknown> }, serverTimestamp: number) =>
    new DecryptedPayload({
      uuid,
      content_type: ContentType.TYPES.Note,
      content: FillItemContent({
        title: 'Minutes',
        text: content.text,
        appData: { [DefaultAppDomain]: { [AppDataField.UserModifiedDate]: longAgo, ...content.domain } },
      } as Partial<ItemContent>),
      dirty: serverTimestamp === 1,
      ...PayloadTimestampDefaults(),
      updated_at_timestamp: serverTimestamp,
    })

  const conflict = (base: FullyFormedPayloadInterface, apply: FullyFormedPayloadInterface) => {
    const collection = new PayloadCollection()
    collection.set(base)
    return new ConflictDelta(ImmutablePayloadCollection.FromCollection(collection), base, apply, historyMap)
  }

  const copiesMadeBy = (delta: ConflictDelta) =>
    delta.result().emits.filter((emitted) => isDecryptedPayload(emitted) && emitted.uuid !== uuid)

  it('names the key the web editor writes', () => {
    // The web package writes this key by its literal name (it runs against a prebuilt copy of
    // this package and cannot rely on a new enum member existing at runtime).
    expect(AppDataField.CollaborationRevision).toBe('collaborationRevision')
  })

  it('keeps the server version, and makes no copy, when two people saved the same body with different stamps', () => {
    const mine = note({ text: 'the same body', domain: { [AppDataField.CollaborationRevision]: stamp(40) } }, 1)
    const theirs = note({ text: 'the same body', domain: { [AppDataField.CollaborationRevision]: stamp(41) } }, 5)
    const delta = conflict(mine, theirs)

    expect(delta.getConflictStrategy()).toBe(ConflictStrategy.KeepApply)
    expect(copiesMadeBy(delta)).toEqual([])
  })

  it('does the same when only one of the two saves was stamped', () => {
    const stamped = note({ text: 'the same body', domain: { [AppDataField.CollaborationRevision]: stamp(40) } }, 1)
    const plain = note({ text: 'the same body' }, 5)

    expect(conflict(stamped, plain).getConflictStrategy()).toBe(ConflictStrategy.KeepApply)
    expect(
      conflict(note({ text: 'the same body' }, 1), stamped.copy({ updated_at_timestamp: 5 })).getConflictStrategy(),
    ).toBe(ConflictStrategy.KeepApply)
  })

  it('still keeps both versions when the bodies differ, whatever their stamps say', () => {
    const sameStamp = { [AppDataField.CollaborationRevision]: stamp(40) }
    const mine = note({ text: 'what I wrote', domain: sameStamp }, 1)
    const theirs = note({ text: 'what they wrote', domain: sameStamp }, 5)
    const delta = conflict(mine, theirs)

    expect(delta.getConflictStrategy()).toBe(ConflictStrategy.DuplicateBaseKeepApply)
    expect(copiesMadeBy(delta)).toHaveLength(1)
  })

  it('ignores nothing else in the app data: a note pinned on one device still differs', () => {
    const mine = note({ text: 'the same body', domain: { [AppDataField.Pinned]: true } }, 1)
    const theirs = note({ text: 'the same body' }, 5)

    expect(conflict(mine, theirs).getConflictStrategy()).not.toBe(ConflictStrategy.KeepApply)
  })

  it('leaves an ordinary note on the path it always took: equal content on two devices is no conflict', () => {
    // Nobody is collaborating on this note. The editor still runs its stamp writer on every
    // save, which leaves an `undefined` entry in memory on the device that saved it.
    const here = note(
      { text: 'byte-equal on both devices', domain: { [AppDataField.CollaborationRevision]: undefined } },
      1,
    )
    const there = note({ text: 'byte-equal on both devices' }, 5)
    const delta = conflict(here, there)

    expect(delta.getConflictStrategy()).toBe(ConflictStrategy.KeepApply)
    expect(copiesMadeBy(delta)).toEqual([])
    expect(conflict(note({ text: 'byte-equal on both devices' }, 1), there).getConflictStrategy()).toBe(
      ConflictStrategy.KeepApply,
    )
  })
})
