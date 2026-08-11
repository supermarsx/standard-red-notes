import { act } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { WebApplication } from '@/Application/WebApplication'
import { NoteViewController } from '../Controller/NoteViewController'
import { SandboxEditor } from './SandboxEditor'
import {
  SANDBOX_RUN_MAX_PAYLOAD_BYTES,
  SANDBOX_RUN_PAYLOAD_LIMIT_MESSAGE,
  SandboxDocument,
  createWebSandboxStarter,
  serializeSandboxDocument,
} from './SandboxDocument'

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

  const renderEditor = (document: SandboxDocument = createWebSandboxStarter()) => {
    const controller = {
      item: {
        uuid: 'sandbox-note',
        text: serializeSandboxDocument(document),
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

  it('rejects an oversized UTF-8 snapshot before creating a runner frame', () => {
    renderEditor({
      ...createWebSandboxStarter(),
      html: '😀'.repeat(SANDBOX_RUN_MAX_PAYLOAD_BYTES / 4 + 1),
      css: '',
      js: '',
    })

    const runButton = container.querySelector<HTMLButtonElement>('button[title="Run code"]')
    act(() => runButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(container.querySelector('iframe')).toBeNull()
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(SANDBOX_RUN_PAYLOAD_LIMIT_MESSAGE)
  })

  it('removes the active frame and its persistent preview when stopped', () => {
    renderEditor()
    const runButton = container.querySelector<HTMLButtonElement>('button[title="Run code"]')
    act(() => runButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(container.querySelector('iframe[title="Web App Sandbox preview"]')).not.toBeNull()
    const stopButton = container.querySelector<HTMLButtonElement>('button[title="Stop and reset sandbox"]')
    expect(stopButton).not.toBeNull()
    act(() => stopButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })))

    expect(container.querySelector('iframe')).toBeNull()
    expect(container.querySelector('button[title="Stop and reset sandbox"]')).toBeNull()
    expect(container.textContent).toContain('Press Run to render this sandbox.')
  })
})
