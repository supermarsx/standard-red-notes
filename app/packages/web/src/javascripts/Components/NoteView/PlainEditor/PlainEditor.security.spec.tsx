/**
 * @jest-environment jsdom
 */
import { WebApplication } from '@/Application/WebApplication'
import { PayloadEmitSource, SNNote } from '@standardnotes/snjs'
import { Deferred } from '@standardnotes/utils'
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { NoteViewController } from '../Controller/NoteViewController'
import { PlainEditor } from './PlainEditor'

jest.mock('@/Utils/getPlaintextFontSize', () => ({
  useResponsiveEditorFontSize: () => '',
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('PlainEditor local propagation lifecycle', () => {
  let container: HTMLElement
  let root: Root
  let isMounted: boolean
  let note: SNNote
  let noteObserver!: (note: SNNote, source: PayloadEmitSource) => void
  let controller: NoteViewController
  let application: WebApplication

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    isMounted = true
    note = {
      uuid: 'plain-note',
      text: '',
      locked: false,
      editorIdentifier: 'org.standardnotes.plain-editor',
      noteType: 'plain',
    } as unknown as SNNote
    controller = {
      item: note,
      isTemplateNote: false,
      addNoteInnerValueChangeObserver: jest.fn((observer) => {
        noteObserver = observer
        return jest.fn()
      }),
      saveAndAwaitLocalPropagation: jest.fn(),
    } as unknown as NoteViewController
    application = {
      notifyWebEvent: jest.fn(),
      addWebEventObserver: jest.fn(() => jest.fn()),
      addEventObserver: jest.fn(() => jest.fn()),
      preferences: { getLocalValue: jest.fn(() => undefined) },
      keyboardService: { addCommandHandler: jest.fn(() => jest.fn()) },
    } as unknown as WebApplication
  })

  afterEach(() => {
    if (isMounted) {
      act(() => root.unmount())
    }
    container.remove()
    jest.clearAllMocks()
  })

  const renderEditor = () => {
    act(() => {
      root.render(
        createElement(PlainEditor, {
          application,
          controller,
          spellcheck: false,
          locked: false,
          onFocus: jest.fn(),
          onBlur: jest.fn(),
        }),
      )
    })
  }

  const changeText = (text: string) => {
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    act(() => {
      setValue?.call(textarea, text)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('does not let an older completion clear the newest save pending state', async () => {
    const firstSave = Deferred<void>()
    const secondSave = Deferred<void>()
    jest
      .mocked(controller.saveAndAwaitLocalPropagation)
      .mockReturnValueOnce(firstSave.promise)
      .mockReturnValueOnce(secondSave.promise)
    renderEditor()

    changeText('first edit')
    changeText('newest edit')

    await act(async () => {
      firstSave.resolve()
      await firstSave.promise
    })
    act(() => {
      noteObserver({ ...note, text: 'stale retrieved body' } as SNNote, PayloadEmitSource.RemoteRetrieved)
    })
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('newest edit')

    await act(async () => {
      secondSave.resolve()
      await secondSave.promise
    })
    act(() => {
      noteObserver({ ...note, text: 'current retrieved body' } as SNNote, PayloadEmitSource.RemoteRetrieved)
    })
    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('current retrieved body')
  })

  it('handles a rejected save after unmount without touching component state', async () => {
    const save = Deferred<void>()
    jest.mocked(controller.saveAndAwaitLocalPropagation).mockReturnValue(save.promise)
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    renderEditor()
    changeText('pending edit')

    act(() => root.unmount())
    isMounted = false
    save.reject()
    await save.promise.catch(() => undefined)
    await act(async () => Promise.resolve())

    expect(consoleError).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('renders an assistant-originated body change without treating it as the editor own echo', () => {
    renderEditor()

    act(() => {
      noteObserver({ ...note, text: 'assistant replacement' } as SNNote, PayloadEmitSource.AssistantChanged)
    })

    expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('assistant replacement')
    expect(controller.saveAndAwaitLocalPropagation).not.toHaveBeenCalled()
  })
})
