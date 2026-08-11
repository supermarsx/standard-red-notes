import { act } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { WebApplication } from '@/Application/WebApplication'
import { NoteViewController } from '../Controller/NoteViewController'
import { SandboxEditor } from './SandboxEditor'
import { createWebSandboxStarter, serializeSandboxDocument } from './SandboxDocument'

jest.mock('@standardnotes/snjs', () => ({
  isPayloadSourceRetrieved: jest.fn(() => false),
}))

jest.mock('@/Components/Icon/Icon', () => ({
  __esModule: true,
  default: () => <span aria-hidden="true" />,
}))

describe('SandboxEditor execution consent', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const renderEditor = () => {
    const controller = {
      item: {
        uuid: 'sandbox-note',
        text: serializeSandboxDocument(createWebSandboxStarter()),
        locked: false,
      },
      addNoteInnerValueChangeObserver: jest.fn(() => jest.fn()),
      registerEditorFlush: jest.fn(() => jest.fn()),
      saveAndAwaitLocalPropagation: jest.fn(() => Promise.resolve()),
    } as unknown as NoteViewController

    act(() => {
      root.render(
        <SandboxEditor application={{} as WebApplication} controller={controller} mode="web" readonly={false} />,
      )
    })
  }

  it('does not create an executable iframe merely by opening a web sandbox', () => {
    renderEditor()

    expect(container.querySelector('iframe')).toBeNull()
    expect(container.textContent).toContain('Opening and editing it never executes code automatically.')
  })

  it('creates a one-shot runner only after the user presses Run', () => {
    renderEditor()
    const runButton = container.querySelector<HTMLButtonElement>('button[title="Run code"]')

    expect(runButton).not.toBeNull()
    act(() => runButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    const frame = container.querySelector<HTMLIFrameElement>('iframe[title="Web App Sandbox preview"]')
    expect(frame).not.toBeNull()
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts')
    expect(frame?.getAttribute('src')).toMatch(/^\/sandbox\.html#[a-f0-9]{32}$/)
  })
})
