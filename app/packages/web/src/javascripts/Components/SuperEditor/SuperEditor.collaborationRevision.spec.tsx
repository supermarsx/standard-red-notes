/**
 * @jest-environment jsdom
 *
 * Two people typing in one note, and a third opening it, produced forty conflicted copies of that
 * note in fifteen seconds. Every one was "the server's version": a stored revision that was simply
 * an older state of the document all three were looking at, kept because its text was not the
 * editor's text.
 *
 * This mounts the real SuperEditor (its Lexical children stubbed) with a live shared document
 * registered for the note, and drives the two places that decide the matter:
 *  - a save says which state of the shared document its body is;
 *  - a retrieved revision that the live document provably contains is NOT copied, one that it
 *    does not contain yet is waited for, and one it never comes to contain still is.
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { FeatureStatus, PayloadEmitSource } from '@standardnotes/snjs'
import type { CollaborationRoomAccessState } from './Collaboration/useCollaborationRoomAccess'

const nullPlugin = () => null

let mockCollaborationAccess: CollaborationRoomAccessState
let mockEditorOnChange: ((value: string, preview: string, bypassDebounce?: boolean) => void | Promise<void>) | undefined
const mockSessionUser = { uuid: 'user-uuid' }

jest.mock('./Collaboration/useCollaborationRoomAccess', () => ({
  useCollaborationRoomAccess: () => mockCollaborationAccess,
}))

jest.mock('./Collaboration/CollaborationKeyDerivation', () => ({
  resolveNoteEncryptionIdentity: (_application: unknown, note: { uuid: string }) => ({
    noteUuid: note.uuid,
    userUuid: 'user-uuid',
    sessionUser: mockSessionUser,
    sourceId: 'source-id',
    keySystemIdentifier: null,
    sharedVaultUuid: null,
  }),
  matchesNoteEncryptionIdentity: () => true,
}))

jest.mock('./BlocksEditorComposer', () => ({
  BlocksEditorComposer: ({ children }: { children?: React.ReactNode }) => createElement('div', null, children),
}))
jest.mock('./BlocksEditor', () => ({
  BlocksEditor: ({ onChange }: { onChange?: typeof mockEditorOnChange }) => {
    mockEditorOnChange = onChange
    return null
  },
}))
jest.mock('./Plugins/ItemSelectionPlugin/ItemSelectionPlugin', () => ({ ItemSelectionPlugin: nullPlugin }))
jest.mock('./Plugins/EncryptedFilePlugin/FilePlugin', () => ({ __esModule: true, default: nullPlugin }))
jest.mock('./Plugins/ItemBubblePlugin/ItemBubblePlugin', () => ({ __esModule: true, default: nullPlugin }))
jest.mock('./Plugins/NodeObserverPlugin/NodeObserverPlugin', () => ({ NodeObserverPlugin: nullPlugin }))
jest.mock('./Plugins/ChangeContentCallback/ChangeContentCallback', () => ({
  ChangeContentCallbackPlugin: nullPlugin,
  registerLatestChangeEditorFunction: () => undefined,
}))
jest.mock('./Plugins/GetMarkdownPlugin/GetMarkdownPlugin', () => ({ __esModule: true, default: nullPlugin }))
jest.mock('./Plugins/ReadonlyPlugin/ReadonlyPlugin', () => ({ __esModule: true, default: nullPlugin }))
jest.mock('./Plugins/AutoFocusPlugin', () => ({ __esModule: true, default: nullPlugin }))
jest.mock('./Plugins/BlockPickerPlugin/BlockPickerPlugin', () => ({ __esModule: true, default: nullPlugin }))
jest.mock('./Plugins/NoteFromSelectionPlugin', () => ({ NoteFromSelectionPlugin: nullPlugin }))
jest.mock('./SuperNoteMarkdownPreview', () => ({ SuperNoteMarkdownPreview: nullPlugin }))
jest.mock('@/Components/Modal/ModalOverlay', () => ({ __esModule: true, default: nullPlugin }))
jest.mock('@/Hooks/usePreference', () => ({ useLocalPreference: () => [1, jest.fn()] }))

import { CollaborativeDocumentRegistry } from './Collaboration/CollaborativeDocumentRegistry'
import {
  COLLABORATION_REVISION_KEY,
  MAX_STAMP_DELETED_RUNS,
  createCollaborationRevisionStamp,
  fingerprintText,
  type CollaborationRevisionStamp,
} from './Collaboration/CollaborationRevisionStamp'
import { CollaborationStatusRegistry } from './Collaboration/CollaborationStatusRegistry'
import { RETRIEVED_REVISION_MERGE_WAIT_MS, SuperEditor } from './SuperEditor'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }),
})

const NOTE_UUID = 'note-uuid'
const EPOCH = 'room_epoch_0000000000000001'

type TestNote = {
  uuid: string
  text: string
  title: string
  locked: boolean
  preview_plain: string
  preview_html: string
  serverUpdatedAtTimestamp: number
  user_uuid: string
  payload: { content: Record<string, unknown>; ejected(): { content: Record<string, unknown> } }
}

/** A revision of the note: its body, its server stamp, and optionally a collaboration stamp. */
function revision(text: string, serverUpdatedAtTimestamp: number, stamp?: CollaborationRevisionStamp): TestNote {
  const content: Record<string, unknown> = {
    text,
    title: 'Note',
    // As its author's save left it: the stamp, and the note's modified date of that same save.
    ...(stamp
      ? {
          appData: {
            'org.standardnotes.sn': {
              [COLLABORATION_REVISION_KEY]: stamp,
              client_updated_at: new Date(stamp.at).toISOString(),
            },
          },
        }
      : {}),
  }
  return {
    uuid: NOTE_UUID,
    text,
    title: 'Note',
    locked: false,
    preview_plain: '',
    preview_html: '',
    serverUpdatedAtTimestamp,
    user_uuid: 'user-uuid',
    payload: { content, ejected: () => ({ content }) },
  }
}

const noopDisposer = () => undefined
let currentNote: TestNote
let observeNote: ((note: TestNote, source: PayloadEmitSource) => void) | undefined
let save: jest.Mock
let duplicateItem: jest.Mock
let unregisterDocument: (() => void) | undefined
/** What the live shared document holds: client id to number of operations. */
let liveVector: Map<number, number>
/** Which of those operations it has deleted: client id to [clock, length] runs. */
let liveDeleted: Map<number, Array<[number, number]>>
let documentListeners: Set<() => void>

const application = {
  platform: 'web',
  sessions: {
    isSignedIn: () => true,
    getUser: () => mockSessionUser,
    isCurrentSessionReadOnly: () => false,
  },
  items: {
    findItem: () => currentNote,
    getItems: () => [],
    streamItems: () => noopDisposer,
  },
  mutator: {
    duplicateItem: (...parameters: unknown[]) => duplicateItem(...parameters),
    changeItem: () => Promise.resolve(),
    deleteItem: () => Promise.resolve(),
  },
  vaults: { getItemVault: () => undefined },
  vaultUsers: { isCurrentUserReadonlyVaultMember: () => false },
  isAuthorizedToRenderItem: () => true,
  encryption: { getRootKey: () => ({ masterKey: 'master' }) },
  features: { getFeatureStatus: () => FeatureStatus.Entitled },
  addEventObserver: () => noopDisposer,
  commands: { addWithShortcut: () => noopDisposer },
  actions: { addPayloadRequestHandler: () => noopDisposer },
  keyboardService: {
    addCommandHandler: () => noopDisposer,
    registerExternalKeyboardShortcutHelpItem: () => noopDisposer,
    registerExternalKeyboardShortcutHelpItems: () => noopDisposer,
  },
  itemControllerGroup: { activeItemViewController: undefined, markVisibleChecklistControllerReady: () => undefined },
  notifyWebEvent: () => undefined,
  sync: {
    sync: () => Promise.resolve(),
    persistPayloads: () => Promise.resolve(),
    getFullContentPayload: () => Promise.resolve(undefined),
  },
}

let container: HTMLElement
let root: Root

const liveRoom = (): CollaborationRoomAccessState =>
  ({
    status: 'ready',
    sourceId: 'source-id',
    userUuid: 'user-uuid',
    sessionUser: mockSessionUser,
    roomKey: 'room-key',
    roomEpoch: EPOCH,
    username: 'user',
    initialEditorState: 'existing body',
    providerOwnsCanonicalState: true,
    editorLease: {
      requestId: 'lease-1',
      shouldBootstrap: false,
      roomEpoch: EPOCH,
      validateAttachment: () => true,
      isAttached: () => true,
      release: () => undefined,
    },
  }) as unknown as CollaborationRoomAccessState

const renderEditor = async (): Promise<void> => {
  const controller = {
    item: currentNote,
    isTemplateNote: false,
    editorHasPendingChanges: () => false,
    flushEditorSerialize: () => undefined,
    registerEditorDurabilityFlush: () => noopDisposer,
    registerEditorFlush: () => noopDisposer,
    addNoteInnerValueChangeObserver: (observer: typeof observeNote) => {
      observeNote = observer
      return noopDisposer
    },
    saveAndAwaitLocalPropagation: (...parameters: unknown[]) => save(...parameters),
    flushAndAwaitPendingSaveStrict: () => Promise.resolve(),
  }
  await act(async () => {
    root.render(
      createElement(SuperEditor, {
        application: application as never,
        controller: controller as never,
        linkingController: { reconcileEditorReferenceChanges: () => Promise.resolve() } as never,
        filesController: {} as never,
        spellcheck: true,
      }),
    )
  })
}

/** Register the live shared document the collaboration plugin would have registered. */
const registerLiveDocument = (options: { epoch?: string; ready?: boolean | (() => boolean) } = {}): void => {
  const ready = typeof options.ready === 'function' ? options.ready : () => options.ready !== false
  unregisterDocument?.()
  unregisterDocument = CollaborativeDocumentRegistry.set(NOTE_UUID, {
    epoch: options.epoch ?? EPOCH,
    state: () => (ready() ? { stateVector: liveVector, deleted: liveDeleted } : undefined),
    subscribe: (listener) => {
      documentListeners.add(listener)
      return () => documentListeners.delete(listener)
    },
  })
}

/**
 * What the editor does when its content changes. The handler is async, so it is awaited inside
 * the act: an act whose callback returns a promise that nobody awaits never closes, and every
 * later render in the file silently does nothing.
 */
const typeIntoEditor = async (text: string): Promise<void> => {
  await act(async () => {
    await mockEditorOnChange?.(text, 'preview')
  })
}

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

/** The server's revision arrives through sync, as the item store delivers it to the editor. */
const retrieve = async (incoming: TestNote): Promise<void> => {
  currentNote = incoming
  act(() => observeNote?.(incoming, PayloadEmitSource.RemoteRetrieved))
  await settle()
}

beforeEach(() => {
  jest.useFakeTimers()
  mockCollaborationAccess = liveRoom()
  mockEditorOnChange = undefined
  observeNote = undefined
  save = jest.fn(() => Promise.resolve())
  duplicateItem = jest.fn(() =>
    Promise.resolve({ uuid: 'copy', duplicate_of: NOTE_UUID, conflictOf: NOTE_UUID, payload: { content: {} } }),
  )
  currentNote = revision('existing body', 1)
  liveVector = new Map([
    [1, 10],
    [2, 7],
  ])
  liveDeleted = new Map()
  documentListeners = new Set()
  CollaborationStatusRegistry.clearRoom(NOTE_UUID)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  unregisterDocument?.()
  unregisterDocument = undefined
  CollaborationStatusRegistry.clearRoom(NOTE_UUID)
  jest.useRealTimers()
})

describe('a save from a collaborative editor says which state of the shared document it is', () => {
  /** Run the mutation a save would apply and return what it wrote under the stamp's key. */
  const stampWrittenBy = (call: unknown[]): unknown => {
    const written = new Map<string, unknown>()
    const parameters = call[0] as { customMutate?: (mutator: unknown) => void }
    parameters.customMutate?.({ setAppDataItem: (key: string, value: unknown) => written.set(key, value) })
    expect(written.has(COLLABORATION_REVISION_KEY)).toBe(true)
    return written.get(COLLABORATION_REVISION_KEY)
  }

  it('stamps the body with the room epoch and the document state it was serialized from', async () => {
    registerLiveDocument()
    await renderEditor()
    // Precondition: the editor is mounted and would save a change at all.
    expect(mockEditorOnChange).toEqual(expect.any(Function))

    await typeIntoEditor('the body as typed')

    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0]).toMatchObject({ text: 'the body as typed', isUserModified: true })
    expect(stampWrittenBy(save.mock.calls[0])).toEqual({
      v: 1,
      epoch: EPOCH,
      sv: [
        [1, 10],
        [2, 7],
      ],
      ds: [],
      text: fingerprintText('the body as typed'),
      at: Date.now(),
    })
  })

  it('stamps what the document has deleted as well as what it holds', async () => {
    liveDeleted = new Map([
      [
        1,
        [
          [2, 3],
          [8, 1],
        ],
      ],
    ])
    registerLiveDocument()
    await renderEditor()

    await typeIntoEditor('a body with two things removed')

    expect(stampWrittenBy(save.mock.calls[0])).toMatchObject({ ds: [[1, [2, 3, 3, 1]]] })
  })

  it('removes the stamp when the document has more deleted runs than a stamp may carry', async () => {
    liveVector = new Map([[1, (MAX_STAMP_DELETED_RUNS + 1) * 2]])
    liveDeleted = new Map([
      [1, Array.from({ length: MAX_STAMP_DELETED_RUNS + 1 }, (_, index) => [index * 2, 1] as [number, number])],
    ])
    registerLiveDocument()
    await renderEditor()

    await typeIntoEditor('a body from a very long session')

    // No proof is better than half of one: the revision will be copied as it always was.
    expect(stampWrittenBy(save.mock.calls[0])).toBeUndefined()
  })

  it('removes the stamp when no live document stands behind the body', async () => {
    await renderEditor()

    await typeIntoEditor('typed with no shared document')

    // Not "writes nothing": an earlier stamp left beside this body would vouch for it.
    expect(stampWrittenBy(save.mock.calls[0])).toBeUndefined()
  })

  it('removes the stamp while the document has not established its state', async () => {
    registerLiveDocument({ ready: false })
    await renderEditor()

    await typeIntoEditor('typed before a peer copy arrived')

    expect(stampWrittenBy(save.mock.calls[0])).toBeUndefined()
  })

  it('reads the vector when the note is mutated, never earlier than the body it describes', async () => {
    registerLiveDocument()
    await renderEditor()

    await typeIntoEditor('the body as typed')
    // The save is a task later than the serialization. In between, the listener that copies this
    // very keystroke into the shared document runs, and a peer's keystroke arrives.
    liveVector = new Map([
      [1, 11],
      [2, 9],
    ])

    // A vector ahead of the body vouches for nothing the body lacks; the one read at
    // serialization, [1, 10], would have left the keystroke that IS in the body unaccounted for.
    expect(stampWrittenBy(save.mock.calls[0])).toMatchObject({
      sv: [
        [1, 11],
        [2, 9],
      ],
      text: fingerprintText('the body as typed'),
    })
  })

  it('removes the stamp when the document was replaced between the serialization and the save', async () => {
    registerLiveDocument()
    await renderEditor()

    await typeIntoEditor('typed into the first document')
    // A remount: another document now stands for the room, and it was not built from this body.
    registerLiveDocument()

    expect(stampWrittenBy(save.mock.calls[0])).toBeUndefined()
  })

  it('removes the stamp when the body was serialized before the document established its state', async () => {
    let established = false
    registerLiveDocument({ ready: () => established })
    await renderEditor()

    await typeIntoEditor('what the editor held before a peer copy arrived')
    established = true

    // The document is established by the time of the save, but this body was not made from it.
    expect(stampWrittenBy(save.mock.calls[0])).toBeUndefined()
  })

  it('removes the stamp when the document stopped vouching for its state before the save', async () => {
    let established = true
    registerLiveDocument({ ready: () => established })
    await renderEditor()

    await typeIntoEditor('typed just before the room was lost')
    established = false

    expect(stampWrittenBy(save.mock.calls[0])).toBeUndefined()
  })
})

describe('a retrieved revision of a note that is open in a live shared document', () => {
  const stampAt = (
    vector: Array<[number, number]>,
    text: string,
    epoch = EPOCH,
    deleted: Array<[number, Array<[number, number]>]> = [],
  ): CollaborationRevisionStamp =>
    createCollaborationRevisionStamp(
      epoch,
      { stateVector: new Map(vector), deleted: new Map(deleted) },
      text,
      Date.now(),
    ) as CollaborationRevisionStamp

  it('is NOT kept as a conflicted copy when the live document already contains it', async () => {
    registerLiveDocument()
    await renderEditor()
    await typeIntoEditor('what the editor shows now')

    // Somebody's save from a second ago: an older state of this same document.
    const older = 'what everybody saw a second ago'
    await retrieve(
      revision(
        older,
        2,
        stampAt(
          [
            [1, 8],
            [2, 7],
          ],
          older,
        ),
      ),
    )
    act(() => {
      jest.advanceTimersByTime(RETRIEVED_REVISION_MERGE_WAIT_MS * 2)
    })
    await settle()

    expect(duplicateItem).not.toHaveBeenCalled()
  })

  it('waits for the relay when the revision holds operations the room has not received, then makes no copy', async () => {
    registerLiveDocument()
    await renderEditor()
    await typeIntoEditor('what the editor shows now')

    // Its author was offline: the stored revision arrives before the operations behind it.
    const offline = 'written while offline'
    await retrieve(
      revision(
        offline,
        2,
        stampAt(
          [
            [1, 12],
            [2, 7],
          ],
          offline,
        ),
      ),
    )
    act(() => {
      jest.advanceTimersByTime(RETRIEVED_REVISION_MERGE_WAIT_MS - 1_000)
    })
    await settle()
    // Still undecided: neither copied nor dismissed.
    expect(duplicateItem).not.toHaveBeenCalled()
    expect(documentListeners.size).toBeGreaterThan(0)

    // The author rejoins and the relay delivers the difference.
    liveVector = new Map([
      [1, 12],
      [2, 7],
    ])
    act(() => documentListeners.forEach((listener) => listener()))
    await settle()
    act(() => {
      jest.advanceTimersByTime(RETRIEVED_REVISION_MERGE_WAIT_MS * 2)
    })
    await settle()

    expect(duplicateItem).not.toHaveBeenCalled()
  })

  it('IS kept as a conflicted copy when the operations never arrive', async () => {
    registerLiveDocument()
    await renderEditor()
    await typeIntoEditor('what the editor shows now')

    const lost = 'written by someone who is gone'
    const incoming = revision(
      lost,
      2,
      stampAt(
        [
          [1, 12],
          [2, 7],
        ],
        lost,
      ),
    )
    await retrieve(incoming)
    act(() => {
      jest.advanceTimersByTime(RETRIEVED_REVISION_MERGE_WAIT_MS - 1)
    })
    await settle()
    expect(duplicateItem).not.toHaveBeenCalled()

    act(() => {
      jest.advanceTimersByTime(1)
    })
    await settle()

    expect(duplicateItem).toHaveBeenCalledTimes(1)
    expect(duplicateItem.mock.calls[0][1]).toBe(true)
    expect(duplicateItem.mock.calls[0][2]).toMatchObject({ text: lost })
  })

  /**
   * TODAY'S OUTCOME for the person who was out of the room and ONLY deleted. Their revision holds
   * no operation the live document lacks -- a deletion is not one -- so the state vector alone
   * would call it an older state of the document, make no copy, and let the next save put the
   * deleted text back with nothing to show for it. The delete set says otherwise: the revision
   * is kept as a conflicted copy, exactly as it was before stamps existed.
   *
   * This is the test for the slice that stores the shared document in the note to flip: with
   * the document's state at hand the deletion can be APPLIED, and no copy is needed.
   */
  it('IS kept as a conflicted copy when its author only deleted while away and the deletion never arrives', async () => {
    registerLiveDocument()
    await renderEditor()
    await typeIntoEditor('Keep this. Remove this.')

    const withoutTheSentence = 'Keep this.'
    const incoming = revision(
      withoutTheSentence,
      2,
      // The very same vector the live document has; three of client 1's operations deleted.
      stampAt(
        [
          [1, 10],
          [2, 7],
        ],
        withoutTheSentence,
        EPOCH,
        [[1, [[4, 3]]]],
      ),
    )
    await retrieve(incoming)
    act(() => {
      jest.advanceTimersByTime(RETRIEVED_REVISION_MERGE_WAIT_MS - 1)
    })
    await settle()
    // Not judged covered on sight, although nothing in its vector is ahead of the document.
    expect(duplicateItem).not.toHaveBeenCalled()

    act(() => {
      jest.advanceTimersByTime(1)
    })
    await settle()

    expect(duplicateItem).toHaveBeenCalledTimes(1)
    expect(duplicateItem.mock.calls[0][2]).toMatchObject({ text: withoutTheSentence })
  })

  it('makes no copy of a deletion-only revision once the deletion has reached the live document', async () => {
    registerLiveDocument()
    await renderEditor()
    await typeIntoEditor('Keep this. Remove this.')

    const withoutTheSentence = 'Keep this.'
    await retrieve(
      revision(
        withoutTheSentence,
        2,
        stampAt(
          [
            [1, 10],
            [2, 7],
          ],
          withoutTheSentence,
          EPOCH,
          [[1, [[4, 3]]]],
        ),
      ),
    )
    act(() => {
      jest.advanceTimersByTime(1_000)
    })
    await settle()
    expect(duplicateItem).not.toHaveBeenCalled()

    // Its author rejoins and the relay delivers the deletion (and one they made since).
    liveDeleted = new Map([[1, [[4, 5]]]])
    act(() => documentListeners.forEach((listener) => listener()))
    await settle()
    act(() => {
      jest.advanceTimersByTime(RETRIEVED_REVISION_MERGE_WAIT_MS * 2)
    })
    await settle()

    expect(duplicateItem).not.toHaveBeenCalled()
  })

  it('is kept as a conflicted copy at once when something wrote the note after the save that stamped it', async () => {
    registerLiveDocument()
    await renderEditor()
    await typeIntoEditor('what the editor shows now')

    // An older build restores this revision from history: the old body comes back WITH the stamp
    // it was saved with, and only the note's modified date says that this is a new decision.
    const restored = 'what the note said on Tuesday'
    const incoming = revision(
      restored,
      2,
      stampAt(
        [
          [1, 8],
          [2, 7],
        ],
        restored,
      ),
    )
    const domain = (incoming.payload.content.appData as Record<string, Record<string, unknown>>)['org.standardnotes.sn']
    domain.client_updated_at = new Date(Date.now() + 60_000).toISOString()
    await retrieve(incoming)

    // The live document covers every operation in it, and that is exactly why it must not be
    // absorbed: a restore is a decision to go back, not an older state arriving late.
    expect(duplicateItem).toHaveBeenCalledTimes(1)
    expect(duplicateItem.mock.calls[0][2]).toMatchObject({ text: restored })
  })

  it.each([
    ['carries no stamp', (text: string) => revision(text, 2)],
    [
      'belongs to a document from before the room was rebuilt',
      (text: string) => revision(text, 2, stampAt([[1, 8]], text, 'room_epoch_0000000000000002')),
    ],
    [
      'has a body that was rewritten after it was stamped',
      (text: string) => revision(text, 2, stampAt([[1, 8]], 'the body the stamp was written with')),
    ],
  ])('is kept as a conflicted copy at once when it %s', async (_name, build) => {
    registerLiveDocument()
    await renderEditor()
    await typeIntoEditor('what the editor shows now')

    await retrieve(build('a body nothing proves the document contains'))

    expect(duplicateItem).toHaveBeenCalledTimes(1)
  })
})
