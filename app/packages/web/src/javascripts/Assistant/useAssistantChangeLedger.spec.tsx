/**
 * @jest-environment jsdom
 */
import { WebApplication } from '@/Application/WebApplication'
import ApplicationProvider from '@/Components/ApplicationProvider'
import { ApplicationEvent, ContentType, SNNote } from '@standardnotes/snjs'
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { useAssistantChangeLedger } from './useAssistantChangeLedger'

jest.mock('@/Hooks/useItemAuthorization', () => ({
  useItemAuthorization: (_application: WebApplication, note: SNNote | undefined) => Boolean(note),
}))

jest.mock('./assistantChangeLedger', () => ({
  getAssistantChangeLedger: (note: SNNote & { testRecords?: unknown[] }) => ({
    version: 1,
    records: note.testRecords ?? [],
  }),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const noteWithRecord = (uuid: string, changeId: string): SNNote =>
  ({
    uuid,
    content_type: ContentType.TYPES.Note,
    testRecords: [{ changeId }],
  }) as unknown as SNNote

const Harness = ({ noteUuid, renders }: { noteUuid: string; renders: string[] }) => {
  const { records } = useAssistantChangeLedger(noteUuid)
  const display = `${noteUuid}:${records.map((record) => record.changeId).join(',')}`
  renders.push(display)
  return createElement('div', null, display)
}

describe('useAssistantChangeLedger identity boundaries', () => {
  let container: HTMLElement
  let root: Root
  let userUuid: string
  let notes: Map<string, SNNote>
  let noteObserver!: (event: {
    changed: { uuid: string }[]
    inserted: { uuid: string }[]
    removed: { uuid: string }[]
  }) => void
  let applicationObserver!: (event: ApplicationEvent) => void | Promise<void>
  let application: WebApplication

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    userUuid = 'account-a'
    notes = new Map()
    application = {
      identifier: 'ledger-test-application',
      sessions: {
        isSignedIn: () => true,
        getUser: () => ({ uuid: userUuid }),
      },
      items: {
        findItem: jest.fn((uuid: string) => notes.get(uuid)),
        streamItems: jest.fn((_type, observer) => {
          noteObserver = observer
          return jest.fn()
        }),
      },
      addEventObserver: jest.fn((observer) => {
        applicationObserver = observer
        return jest.fn()
      }),
    } as unknown as WebApplication
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    jest.clearAllMocks()
  })

  const render = (noteUuid: string, renders: string[]): void => {
    root.render(
      createElement(ApplicationProvider, {
        application,
        children: createElement(Harness, { noteUuid, renders }),
      }),
    )
  }

  it('synchronously hides the previous note while an exact note UUID switch resolves', () => {
    const renders: string[] = []
    notes.set('note-a', noteWithRecord('note-a', 'change-a'))
    notes.set('note-b', noteWithRecord('note-b', 'change-b'))

    act(() => render('note-a', renders))
    expect(container.textContent).toBe('note-a:change-a')

    act(() => render('note-b', renders))
    expect(container.textContent).toBe('note-b:change-b')
    expect(renders).not.toContain('note-b:change-a')

    notes.set('note-b', noteWithRecord('wrong-note-uuid', 'foreign-change'))
    act(() => noteObserver({ changed: [{ uuid: 'note-b' }], inserted: [], removed: [] }))
    expect(container.textContent).toBe('note-b:')
  })

  it('clears decrypted records before a principal switch and waits for the new account item event', () => {
    const renders: string[] = []
    notes.set('shared-note-id', noteWithRecord('shared-note-id', 'account-a-change'))
    act(() => render('shared-note-id', renders))
    expect(container.textContent).toBe('shared-note-id:account-a-change')

    userUuid = 'account-b'
    notes.set('shared-note-id', noteWithRecord('shared-note-id', 'account-b-change'))
    const transitionRenderStart = renders.length
    act(() => {
      void applicationObserver(ApplicationEvent.SignedIn)
    })

    expect(container.textContent).toBe('shared-note-id:')
    expect(renders.slice(transitionRenderStart)).not.toContain('shared-note-id:account-a-change')

    act(() => noteObserver({ changed: [{ uuid: 'shared-note-id' }], inserted: [], removed: [] }))
    expect(container.textContent).toBe('shared-note-id:account-b-change')
    expect(renders.slice(transitionRenderStart)).not.toContain('shared-note-id:account-a-change')
  })
})
