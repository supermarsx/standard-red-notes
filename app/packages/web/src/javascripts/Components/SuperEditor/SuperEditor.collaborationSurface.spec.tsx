/**
 * @jest-environment jsdom
 *
 * REGRESSION GUARD for the user-visible bug this change fixes.
 *
 * SuperEditor used to render this instead of the editor whenever the encrypted
 * room was still being prepared:
 *
 *   {collaborationAccess.status === 'preparing' ? (
 *     <div …>Preparing encrypted collaboration…</div>
 *   ) : …}
 *
 * Preparation runs on every Super note open and, on a deployment whose
 * collaboration gateway is unreachable, it runs and fails repeatedly — so the
 * editing surface kept vanishing out from under the user. Collaboration state
 * must NEVER remove, cover or disable the editing surface; it now reports itself
 * in the title-bar status row instead.
 *
 * This mounts the real SuperEditor with its heavy Lexical children stubbed and
 * asserts the composer is present in EVERY collaboration state.
 */
import { act, createElement, ReactNode } from 'react'
import { createRoot, Root } from 'react-dom/client'
import type { CollaborationRoomAccessState } from './Collaboration/useCollaborationRoomAccess'

const stub =
  (testId: string) =>
  ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-testid': testId }, children)

const nullPlugin = () => null

let mockCollaborationAccess: CollaborationRoomAccessState

jest.mock('./Collaboration/useCollaborationRoomAccess', () => ({
  useCollaborationRoomAccess: () => mockCollaborationAccess,
}))

jest.mock('./Collaboration/CollaborationKeyDerivation', () => ({
  resolveNoteEncryptionIdentity: (_application: unknown, note: { uuid: string }) => ({
    noteUuid: note.uuid,
    userUuid: 'user-uuid',
    sessionUser: { uuid: 'user-uuid' },
    sourceId: 'source-id',
    keySystemIdentifier: null,
    sharedVaultUuid: null,
  }),
  matchesNoteEncryptionIdentity: () => true,
}))

jest.mock('./BlocksEditorComposer', () => ({ BlocksEditorComposer: stub('blocks-editor-composer') }))
jest.mock('./BlocksEditor', () => ({ BlocksEditor: stub('blocks-editor') }))
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

import { CollaborationStatusRegistry } from './Collaboration/CollaborationStatusRegistry'
import { SuperEditor } from './SuperEditor'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom has no matchMedia; the editor's responsive font-size hook needs one.
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

const note = {
  uuid: NOTE_UUID,
  text: 'existing body',
  title: 'Note',
  locked: false,
  preview_plain: '',
  preview_html: '',
  serverUpdatedAtTimestamp: 1,
  user_uuid: 'user-uuid',
  payload: { content: {} },
}

const noopDisposer = () => undefined

const application = {
  platform: 'web',
  sessions: {
    isSignedIn: () => true,
    getUser: () => ({ uuid: 'user-uuid' }),
    isCurrentSessionReadOnly: () => false,
  },
  items: { findItem: () => note, streamItems: () => noopDisposer },
  vaults: { getItemVault: () => undefined },
  vaultUsers: { isCurrentUserReadonlyVaultMember: () => false },
  isAuthorizedToRenderItem: () => true,
  encryption: { getRootKey: () => ({ masterKey: 'master' }) },
  features: { getFeatureStatus: () => 'entitled' },
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
  sync: { sync: () => Promise.resolve() },
}

const controller = {
  item: note,
  isTemplateNote: false,
  editorHasPendingChanges: () => false,
  flushEditorSerialize: () => undefined,
  registerEditorDurabilityFlush: () => noopDisposer,
  registerEditorFlush: () => noopDisposer,
  addNoteInnerValueChangeObserver: () => noopDisposer,
  saveAndAwaitLocalPropagation: () => Promise.resolve(),
  flushAndAwaitPendingSaveStrict: () => Promise.resolve(),
}

let container: HTMLElement
let root: Root

const renderEditor = async (): Promise<void> => {
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

beforeEach(() => {
  mockCollaborationAccess = { status: 'preparing' }
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
  CollaborationStatusRegistry.clearRoom(NOTE_UUID)
})

const composer = (): Element | null => container.querySelector('[data-testid="blocks-editor-composer"]')

describe('the editing surface survives every collaboration state', () => {
  /**
   * Exhaustive over `CollaborationRoomAccessState`. `ready` appears twice on
   * purpose: an authorized room that has not produced a lease and initial state
   * is a DIFFERENT render path from a fully live one, and it is the path a
   * half-working gateway parks on.
   */
  const states: Array<[string, CollaborationRoomAccessState]> = [
    ['preparing', { status: 'preparing' }],
    ['disabled', { status: 'disabled', reason: 'Live collaboration is offline.' } as CollaborationRoomAccessState],
    ['ready but still settling (no lease)', { status: 'ready' } as CollaborationRoomAccessState],
    [
      'ready with a lease',
      {
        status: 'ready',
        sourceId: 'source-id',
        userUuid: 'user-uuid',
        sessionUser: { uuid: 'user-uuid' },
        roomKey: 'room-key',
        roomEpoch: 'epoch',
        username: 'user',
        initialEditorState: 'body',
        editorLease: { requestId: 'lease-1', shouldBootstrap: false },
      } as unknown as CollaborationRoomAccessState,
    ],
  ]

  it.each(states)('renders the editor while collaboration is %s', async (_name, state) => {
    mockCollaborationAccess = state

    await renderEditor()

    expect(composer()).not.toBeNull()
    expect(container.querySelector('[data-testid="blocks-editor"]')).not.toBeNull()
  })

  it('keeps the editor for a "preparing" that NEVER settles', async () => {
    mockCollaborationAccess = { status: 'preparing' }

    await renderEditor()

    // Re-render repeatedly without the status ever resolving — the deployment
    // where the gateway answers 503 SYNC_DISABLED and preparation never
    // completes. The editing surface must survive indefinitely.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await renderEditor()
      expect(composer()).not.toBeNull()
    }

    expect(container.textContent).not.toContain('Preparing encrypted collaboration')
    expect(container.querySelector('[data-testid="blocks-editor"]')).not.toBeNull()
  })

  it('never renders the removed "Preparing encrypted collaboration" takeover', async () => {
    mockCollaborationAccess = { status: 'preparing' }

    await renderEditor()

    expect(container.textContent).not.toContain('Preparing encrypted collaboration')
    expect(composer()).not.toBeNull()
  })

  it('keeps the editor mounted across the whole preparing -> disabled transition', async () => {
    await renderEditor()
    expect(composer()).not.toBeNull()

    mockCollaborationAccess = {
      status: 'disabled',
      reason: 'Live collaboration is offline and will retry when the encrypted gateway reconnects.',
    } as CollaborationRoomAccessState
    await renderEditor()

    expect(composer()).not.toBeNull()
    expect(container.textContent).not.toContain('Preparing encrypted collaboration')
  })
})

describe('collaboration state is published for the title-bar chip instead', () => {
  it('publishes preparing while the room is being derived', async () => {
    await renderEditor()

    expect(CollaborationStatusRegistry.getState(NOTE_UUID)).toEqual({
      status: { kind: 'preparing' },
      hasBeenActive: false,
    })
  })

  it('publishes the unavailable reason so the chip can explain the failure', async () => {
    mockCollaborationAccess = {
      status: 'disabled',
      reason: 'Sign in to use live collaboration.',
    } as CollaborationRoomAccessState

    await renderEditor()

    expect(CollaborationStatusRegistry.getState(NOTE_UUID)).toEqual({
      status: { kind: 'unavailable', reason: 'Sign in to use live collaboration.' },
      hasBeenActive: false,
    })
  })

  it('deregisters the room when the editor unmounts', async () => {
    await renderEditor()
    expect(CollaborationStatusRegistry.getState(NOTE_UUID)).toBeDefined()

    await act(async () => {
      root.unmount()
    })
    root = createRoot(container)

    expect(CollaborationStatusRegistry.getState(NOTE_UUID)).toBeUndefined()
  })
})
