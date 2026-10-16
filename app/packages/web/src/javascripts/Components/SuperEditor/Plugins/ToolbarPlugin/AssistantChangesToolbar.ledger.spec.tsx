/** @jest-environment jsdom */
import { act, forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { TextEncoder as NodeTextEncoder } from 'node:util'
import {
  ApplicationEvent,
  ContentType,
  DecryptedPayload,
  FillItemContent,
  MutationType,
  NoteContent,
  NoteMutator,
  NoteType,
  PayloadSource,
  PayloadTimestampDefaults,
  SNNote,
} from '@standardnotes/snjs'
import type { LexicalEditor } from 'lexical'
import type { WebApplication } from '@/Application/WebApplication'
import ApplicationProvider from '@/Components/ApplicationProvider'
import {
  appendAssistantChangeRecord,
  createAssistantChangeRecord,
  getAssistantChangeLedger,
  NoteAssistantChangesKey,
} from '@/Assistant/assistantChangeLedger'
import { buildAssistantNoteChange, captureAssistantNoteSnapshot } from '@/Assistant/assistantNoteChanges'
import AssistantChangesToolbar from './AssistantChangesToolbar'

jest.mock('@ariakit/react', () => ({
  ToolbarItem: forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>((props, ref) => (
    <button {...props} ref={ref} />
  )),
}))
jest.mock('@/Components/Icon/Icon', () => ({ __esModule: true, default: () => null }))
jest.mock('@/Components/Popover/Popover', () => ({
  __esModule: true,
  default: ({ open, children }: { open: boolean; children: ReactNode }) => {
    return open ? <div role="dialog">{children}</div> : null
  },
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const createNote = (text: string) =>
  new SNNote(
    new DecryptedPayload<NoteContent>(
      {
        uuid: 'tracked-note',
        content_type: ContentType.TYPES.Note,
        content: FillItemContent<NoteContent>({ title: 'Tracked note', text, noteType: NoteType.Plain }),
        ...PayloadTimestampDefaults(),
      },
      PayloadSource.Constructor,
    ),
  )

describe('AI changes toolbar with real encrypted note ledger', () => {
  let root: Root
  let container: HTMLDivElement
  let current: SNNote
  let allowed: boolean
  let application: WebApplication
  const applicationObservers = new Set<(event: ApplicationEvent) => unknown>()
  const itemObservers = new Map<
    string,
    Set<(event: { changed: SNNote[]; inserted: SNNote[]; removed: SNNote[] }) => void>
  >()
  const editor = { getRootElement: () => null } as unknown as LexicalEditor
  const notifyItem = () =>
    itemObservers
      .get(ContentType.TYPES.Note)
      ?.forEach((callback) => callback({ changed: [current], inserted: [], removed: [] }))
  const flush = async () => {
    for (let index = 0; index < 20; index++) {
      await Promise.resolve()
    }
  }

  beforeEach(() => {
    if (!globalThis.TextEncoder) {
      Object.defineProperty(globalThis, 'TextEncoder', { value: NodeTextEncoder, configurable: true })
    }
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    current = createNote('after AI edit')
    allowed = true
    applicationObservers.clear()
    itemObservers.clear()
    application = {
      sessions: {
        isSignedIn: () => true,
        getUser: () => ({ uuid: 'user-one' }),
        isCurrentSessionReadOnly: () => false,
      },
      isAuthorizedToRenderItem: (note: SNNote) => allowed && note.uuid === current.uuid,
      items: {
        findItem: (uuid: string) => (uuid === current.uuid ? current : undefined),
        streamItems: (
          type: string,
          callback: (event: { changed: SNNote[]; inserted: SNNote[]; removed: SNNote[] }) => void,
        ) => {
          const callbacks = itemObservers.get(type) ?? new Set()
          callbacks.add(callback)
          itemObservers.set(type, callbacks)
          return () => callbacks.delete(callback)
        },
      },
      addEventObserver: (callback: (event: ApplicationEvent) => unknown) => {
        applicationObservers.add(callback)
        return () => applicationObservers.delete(callback)
      },
      vaultLocks: { addEventObserver: () => () => undefined },
      vaults: { getItemVault: () => undefined },
      vaultUsers: { isCurrentUserReadonlyVaultMember: () => false },
      itemControllerGroup: { itemControllers: [] },
      sync: { sync: jest.fn().mockResolvedValue(undefined) },
      mutator: {
        changeItem: async (note: SNNote, mutate: (mutator: NoteMutator) => void, type: MutationType) => {
          const mutator = new NoteMutator(note, type)
          mutate(mutator)
          current = new SNNote(mutator.getResult())
          notifyItem()
          return current
        },
      },
    } as unknown as WebApplication
    act(() =>
      root.render(
        <ApplicationProvider application={application}>
          <AssistantChangesToolbar noteUuid={current.uuid} editor={editor} />
        </ApplicationProvider>,
      ),
    )
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const registerActualEdit = () => {
    const change = buildAssistantNoteChange({
      noteUuid: current.uuid,
      before: captureAssistantNoteSnapshot(createNote('before AI edit')),
      after: captureAssistantNoteSnapshot(current),
    })!
    const record = createAssistantChangeRecord({
      changeId: 'real-change',
      noteUuid: current.uuid,
      source: { assistantMessageId: 'message', assistantRunId: 'run', toolCallId: 'patch' },
      baseRevision: { contentHash: 'before-hash' },
      newRevision: { contentHash: 'after-hash' },
      effects: [
        {
          operationId: 'replace-operation',
          type: 'replace-text',
          summary: 'Updated the selected paragraph.',
          affected: [],
          beforeFragment: 'before AI edit',
          afterFragment: 'after AI edit',
        },
      ],
      undo: change,
    })
    const mutator = new NoteMutator(current, MutationType.NoUpdateUserTimestamps)
    mutator.setAppDataItem(NoteAssistantChangesKey, appendAssistantChangeRecord(current, record))
    current = new SNNote(mutator.getResult())
    act(() => notifyItem())
  }
  const open = () =>
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="AI changes, 1 change"]')!.click())

  it('refreshes the actual stored record count and operation after a note event, then hides fragments on permission loss', () => {
    expect(container.textContent).toContain('AI changes (0)')
    registerActualEdit()
    expect(container.textContent).toContain('AI changes (1)')
    open()
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('Updated the selected paragraph.')
    expect(container.textContent).toContain('before AI edit')
    expect(container.textContent).toContain('after AI edit')
    expect(container.querySelector('pre[aria-label="AI changes made to Tracked note"]')?.textContent).toContain(
      '-before AI edit',
    )
    allowed = false
    act(() => applicationObservers.forEach((callback) => callback(ApplicationEvent.UnprotectedSessionExpired)))
    expect(container.textContent).toBe('')
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  it('preserves the ledger through an ordinary editor mutation and performs guarded undo from the real panel', async () => {
    registerActualEdit()
    await act(async () => {
      await application.mutator.changeItem<NoteMutator, SNNote>(
        current,
        (mutator) => {
          mutator.text = 'after AI edit'
          mutator.preview_plain = 'after AI edit'
        },
        MutationType.NoUpdateUserTimestamps,
      )
    })
    expect(getAssistantChangeLedger(current).records).toHaveLength(1)
    open()
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Undo')!
        .click()
      await flush()
    })
    expect(current.text).toBe('before AI edit')
    expect(getAssistantChangeLedger(current).records[0].status).toBe('undone')
    expect(container.textContent).toContain('undone')
    expect(container.textContent).toContain('AI changes (1)')
  })

  it('keeps a later human edit when undo no longer matches the recorded snapshot', async () => {
    registerActualEdit()
    await act(async () => {
      await application.mutator.changeItem<NoteMutator, SNNote>(
        current,
        (mutator) => {
          mutator.text = 'later human edit'
        },
        MutationType.UpdateUserTimestamps,
      )
    })
    open()
    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Undo')!
        .click()
      await flush()
    })
    expect(current.text).toBe('later human edit')
    expect(getAssistantChangeLedger(current).records[0].status).toBe('applied')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('note changed again')
  })
})
