/**
 * @jest-environment jsdom
 *
 * EDITOR-LEVEL end-to-end test for live co-editing. Unlike the provider unit
 * test (which asserts two Y.Docs converge), this mounts two REAL Lexical editors
 * wired with @lexical/react's CollaborationPlugin — the exact component the Super
 * editor uses — and proves that typing into one editor makes the text appear in
 * the OTHER editor. This exercises the actual @lexical/yjs binding
 * (editor -> Y.Doc -> relay -> Y.Doc -> editor), not just the transport.
 *
 * Transport here is an in-memory hub that mirrors the gateway's room semantics;
 * the separate collab-yjs.e2e.mjs proves the same flow over the LIVE gateway
 * with real encryption.
 */
import { act, createElement, useEffect } from 'react'
import { TextDecoder, TextEncoder } from 'node:util'
import { createRoot, Root } from 'react-dom/client'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { CollaborationPlugin } from '@lexical/react/LexicalCollaborationPlugin'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $getRoot, $createParagraphNode, $createTextNode, LexicalEditor } from 'lexical'
import {
  $createListItemNode,
  $createListNode,
  $isListItemNode,
  $isListNode,
  ListItemNode,
  ListNode,
} from '@lexical/list'
import * as Y from 'yjs'
import type { Doc } from 'yjs'
import { EncryptedYjsProvider } from './EncryptedYjsProvider'
import type { RoomCipher } from './RoomCrypto'
import type { CollabChannel, CollabFrame } from './CollabChannel'
import { EphemeralLexicalCollaboration } from './CollaborationPlugin'
import {
  $getChecklistSchedule,
  $setChecklistSchedule,
  $setChecklistTodoId,
  CHECKLIST_SCHEDULE_VERSION,
  type ChecklistSchedule,
} from '../Lexical/Nodes/ChecklistItemNode'
import { $setChecklistItemChecked } from '../Checklist/ChecklistEditorMutations'
import { createChecklistRecurrence } from '../Checklist/checklistRecurrence'
import { CheckListPlugin } from '../Plugins/CheckListPlugin'

jest.mock('../../ApplicationProvider', () => {
  const application = {
    platform: 'web',
    keyboardService: {
      activeModifiers: new Set(),
      registerExternalKeyboardShortcutHelpItem: () => () => undefined,
    },
  }
  return { useApplication: () => application }
})

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
Object.defineProperty(globalThis, 'TextEncoder', { configurable: true, value: TextEncoder })
Object.defineProperty(globalThis, 'TextDecoder', { configurable: true, value: TextDecoder })

/** Fast identity-equivalent transport used only to isolate editor/provider behavior. */
const createTestTransportCipher = (): RoomCipher => ({
  encrypt: async (plaintext) => Buffer.from(plaintext).toString('base64'),
  decrypt: async (payload) => new Uint8Array(Buffer.from(payload, 'base64')),
})

// Gateway-mirroring loopback: frames go to every OTHER member of the room; a join
// prompts existing members to re-sync.
class LoopbackHub {
  private readonly handlers = new Map<symbol, (f: CollabFrame) => void>()
  private readonly rooms = new Map<string, Set<symbol>>()
  private readonly electedEditorRooms = new Set<string>()
  private paused = false
  private readonly queuedFrames: Array<{ member: symbol; frame: CollabFrame }> = []

  pause(): void {
    this.paused = true
  }

  resume(): void {
    this.paused = false
    for (const { member, frame } of this.queuedFrames.splice(0)) {
      this.handlers.get(member)?.(frame)
    }
  }

  reserveEditorBootstrap(room: string): boolean {
    if (this.electedEditorRooms.has(room)) {
      return false
    }
    this.electedEditorRooms.add(room)
    return true
  }

  channel(): CollabChannel {
    const id = Symbol('chan')
    return {
      isConnected: () => true,
      subscribe: (h) => {
        this.handlers.set(id, h)
        return () => this.handlers.delete(id)
      },
      send: (f) => this.relay(id, f),
      authorize: () => Promise.resolve('test-capability'),
    }
  }
  private relay(from: symbol, frame: CollabFrame): void {
    if (frame.t === 'room-join') {
      const set = this.rooms.get(frame.room) ?? new Set<symbol>()
      set.add(from)
      this.rooms.set(frame.room, set)
      this.handlers.get(from)?.({ t: 'room-joined', room: frame.room, requestId: frame.requestId })
      for (const m of set) {
        if (m !== from) {
          this.handlers.get(m)?.({ t: 'room-sync', room: frame.room })
        }
      }
      return
    }
    if (frame.t === 'room-leave') {
      this.rooms.get(frame.room)?.delete(from)
      return
    }
    const members = this.rooms.get(frame.room)
    if (!members) {
      return
    }
    for (const m of members) {
      if (m !== from) {
        if (this.paused) {
          this.queuedFrames.push({ member: m, frame })
        } else {
          this.handlers.get(m)?.(frame)
        }
      }
    }
  }
}

type Captured = { editor: LexicalEditor; provider: EncryptedYjsProvider }

function CapturePlugin({ onReady }: { onReady: (editor: LexicalEditor) => void }) {
  const [editor] = useLexicalComposerContext()
  useEffect(() => {
    onReady(editor)
  }, [editor, onReady])
  return null
}

function CollabEditor(props: {
  hub: LoopbackHub
  room: string
  bootstrap: boolean
  initialText?: string
  checklistPlugin?: boolean
  capture: (c: Captured) => void
}) {
  const { hub, room, bootstrap, initialText, checklistPlugin, capture } = props
  let provider: EncryptedYjsProvider
  const providerFactory = (id: string, docMap: Map<string, Doc>) => {
    let doc = docMap.get(id)
    if (!doc) {
      doc = new Y.Doc()
      docMap.set(id, doc)
    }
    provider = new EncryptedYjsProvider(doc, room, hub.channel(), createTestTransportCipher())
    return provider
  }
  return createElement(
    LexicalComposer,
    {
      initialConfig: {
        namespace: 'Test',
        editorState: null,
        nodes: [ListNode, ListItemNode],
        onError: (e: Error) => {
          throw e
        },
      },
    },
    createElement(PlainTextPlugin, {
      contentEditable: createElement(ContentEditable, {}),
      placeholder: null,
      ErrorBoundary: LexicalErrorBoundary,
    }),
    createElement(
      EphemeralLexicalCollaboration,
      { lifetimeKey: `${room}:test-lease` },
      createElement(CollaborationPlugin, {
        id: room,
        providerFactory,
        shouldBootstrap: bootstrap,
        initialEditorState: initialText
          ? () => {
              const root = $getRoot()
              root.clear()
              const paragraph = $createParagraphNode()
              paragraph.append($createTextNode(initialText))
              root.append(paragraph)
            }
          : undefined,
      }),
    ),
    checklistPlugin ? createElement(CheckListPlugin, {}) : null,
    createElement(CapturePlugin, { onReady: (editor: LexicalEditor) => capture({ editor, provider }) }),
  )
}

async function flush(...providers: EncryptedYjsProvider[]): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await act(async () => {
      await Promise.all(providers.map((p) => p.flush()))
      await Promise.resolve()
    })
  }
}

function textOf(editor: LexicalEditor): string {
  let text = ''
  editor.getEditorState().read(() => {
    text = $getRoot().getTextContent()
  })
  return text
}

function typeInto(editor: LexicalEditor, content: string): void {
  act(() => {
    editor.update(
      () => {
        const root = $getRoot()
        root.clear()
        const p = $createParagraphNode()
        p.append($createTextNode(content))
        root.append(p)
      },
      { discrete: true },
    )
  })
}

function checklistState(editor: LexicalEditor): { checked: boolean; schedule?: ChecklistSchedule } {
  let result: { checked: boolean; schedule?: ChecklistSchedule } = { checked: false }
  editor.getEditorState().read(() => {
    const list = $getRoot().getFirstChild()
    const item = $isListNode(list) ? list.getFirstChild() : undefined
    if (!$isListItemNode(item)) {
      throw new Error('Expected a checklist item')
    }
    result = { checked: Boolean(item.getChecked()), schedule: $getChecklistSchedule(item) }
  })
  return result
}

describe('Collaborative editor (editor-level e2e)', () => {
  jest.setTimeout(20000)

  it('text typed in editor A appears in editor B through the relay', async () => {
    const hub = new LoopbackHub()
    const room = 'note-editor-1'
    const containerA = document.createElement('div')
    const containerB = document.createElement('div')
    document.body.append(containerA, containerB)

    let capA: Captured | undefined
    let capB: Captured | undefined
    let rootA: Root
    let rootB: Root

    await act(async () => {
      rootA = createRoot(containerA)
      rootA.render(createElement(CollabEditor, { hub, room, bootstrap: true, capture: (c) => (capA = c) }))
    })
    await act(async () => {
      rootB = createRoot(containerB)
      rootB.render(createElement(CollabEditor, { hub, room, bootstrap: false, capture: (c) => (capB = c) }))
    })
    expect(capA && capB).toBeTruthy()
    await flush(capA!.provider, capB!.provider)

    typeInto(capA!.editor, 'hello from A')
    await flush(capA!.provider, capB!.provider)

    expect(textOf(capA!.editor)).toContain('hello from A')
    expect(textOf(capB!.editor)).toContain('hello from A')

    await act(async () => {
      rootA!.unmount()
      rootB!.unmount()
    })
  })

  it('a late joiner sees content that already existed in the shared doc', async () => {
    const hub = new LoopbackHub()
    const room = 'note-editor-2'
    const containerA = document.createElement('div')
    document.body.append(containerA)

    let capA: Captured | undefined
    let rootA: Root
    await act(async () => {
      rootA = createRoot(containerA)
      rootA.render(createElement(CollabEditor, { hub, room, bootstrap: true, capture: (c) => (capA = c) }))
    })
    await flush(capA!.provider)
    typeInto(capA!.editor, 'written before B joined')
    await flush(capA!.provider)

    // B joins late.
    const containerB = document.createElement('div')
    document.body.append(containerB)
    let capB: Captured | undefined
    let rootB: Root
    await act(async () => {
      rootB = createRoot(containerB)
      rootB.render(createElement(CollabEditor, { hub, room, bootstrap: false, capture: (c) => (capB = c) }))
    })
    await flush(capA!.provider, capB!.provider)

    expect(textOf(capB!.editor)).toContain('written before B joined')

    await act(async () => {
      rootA!.unmount()
      rootB!.unmount()
    })
  })

  it('elects one bootstrapper when two production editors open simultaneously, avoiding duplicated note text', async () => {
    const hub = new LoopbackHub()
    const room = 'note-editor-dual-bootstrap'
    const containerA = document.createElement('div')
    const containerB = document.createElement('div')
    document.body.append(containerA, containerB)
    let capA: Captured | undefined
    let capB: Captured | undefined
    let rootA: Root
    let rootB: Root
    const bootstrapA = hub.reserveEditorBootstrap(room)
    const bootstrapB = hub.reserveEditorBootstrap(room)
    expect([bootstrapA, bootstrapB].filter(Boolean)).toHaveLength(1)

    await act(async () => {
      rootA = createRoot(containerA)
      rootB = createRoot(containerB)
      rootA.render(
        createElement(CollabEditor, {
          hub,
          room,
          bootstrap: bootstrapA,
          initialText: 'persisted note body',
          capture: (captured) => (capA = captured),
        }),
      )
      rootB.render(
        createElement(CollabEditor, {
          hub,
          room,
          bootstrap: bootstrapB,
          initialText: 'persisted note body',
          capture: (captured) => (capB = captured),
        }),
      )
    })
    await flush(capA!.provider, capB!.provider)

    expect(textOf(capA!.editor)).toBe('persisted note body')
    expect(textOf(capB!.editor)).toBe('persisted note body')

    await act(async () => {
      rootA!.unmount()
      rootB!.unmount()
    })
  })

  it('converges concurrent real-editor schedule edit and recurrence completion without a torn pair', async () => {
    const hub = new LoopbackHub()
    const room = 'note-editor-atomic-checklist-schedule'
    const containerA = document.createElement('div')
    const containerB = document.createElement('div')
    document.body.append(containerA, containerB)
    let capA: Captured | undefined
    let capB: Captured | undefined
    let rootA: Root
    let rootB: Root

    await act(async () => {
      rootA = createRoot(containerA)
      rootA.render(createElement(CollabEditor, { hub, room, bootstrap: true, capture: (c) => (capA = c) }))
    })
    await act(async () => {
      rootB = createRoot(containerB)
      rootB.render(createElement(CollabEditor, { hub, room, bootstrap: false, capture: (c) => (capB = c) }))
    })
    await flush(capA!.provider, capB!.provider)

    const initialDueAt = '2026-08-16T09:00:00.000Z'
    const initialRecurrence = createChecklistRecurrence('daily', initialDueAt, 'UTC')!
    act(() => {
      capA!.editor.update(
        () => {
          const item = $createListItemNode(false).append($createTextNode('Atomic schedule'))
          $setChecklistTodoId(item, 'todo-atomic-collaboration')
          $setChecklistSchedule(item, initialDueAt, initialRecurrence)
          $getRoot().clear().append($createListNode('check').append(item))
        },
        { discrete: true },
      )
    })
    await flush(capA!.provider, capB!.provider)
    expect(checklistState(capB!.editor).schedule).toMatchObject({
      dueAt: initialDueAt,
      recurrence: { frequency: 'daily' },
    })

    const editedDueAt = '2026-09-30T09:00:00.000Z'
    const editedRecurrence = createChecklistRecurrence('monthly', editedDueAt, 'UTC')!
    const authoredEdit = {
      version: CHECKLIST_SCHEDULE_VERSION,
      dueAt: editedDueAt,
      recurrence: editedRecurrence,
    }
    const authoredCompletion = {
      version: CHECKLIST_SCHEDULE_VERSION,
      dueAt: '2026-08-17T09:00:00.000Z',
      recurrence: initialRecurrence,
    }
    hub.pause()
    act(() => {
      capA!.editor.update(
        () => {
          const list = $getRoot().getFirstChild()
          const item = $isListNode(list) ? list.getFirstChild() : undefined
          if (!$isListItemNode(item)) {
            throw new Error('Expected editor A checklist item')
          }
          $setChecklistSchedule(item, editedDueAt, editedRecurrence)
        },
        { discrete: true },
      )
      capB!.editor.update(
        () => {
          const list = $getRoot().getFirstChild()
          const item = $isListNode(list) ? list.getFirstChild() : undefined
          if (!$isListItemNode(item)) {
            throw new Error('Expected editor B checklist item')
          }
          $setChecklistItemChecked(item, true, Date.parse('2026-08-16T10:00:00.000Z'))
        },
        { discrete: true },
      )
    })
    await flush(capA!.provider, capB!.provider)
    hub.resume()
    await flush(capA!.provider, capB!.provider)

    const stateA = checklistState(capA!.editor)
    const stateB = checklistState(capB!.editor)
    expect(stateA).toEqual(stateB)
    expect([authoredEdit, authoredCompletion]).toContainEqual(stateA.schedule)
    expect(stateA.checked).toBe(false)

    await act(async () => {
      rootA!.unmount()
      rootB!.unmount()
    })
  })

  it('repairs concurrent recurrence-add and ordinary completion through the production checklist transform', async () => {
    const hub = new LoopbackHub()
    const room = 'note-editor-recurring-activation'
    const containerA = document.createElement('div')
    const containerB = document.createElement('div')
    document.body.append(containerA, containerB)
    let capA: Captured | undefined
    let capB: Captured | undefined
    let rootA: Root
    let rootB: Root

    await act(async () => {
      rootA = createRoot(containerA)
      rootA.render(
        createElement(CollabEditor, {
          hub,
          room,
          bootstrap: true,
          checklistPlugin: true,
          capture: (captured) => (capA = captured),
        }),
      )
    })
    await act(async () => {
      rootB = createRoot(containerB)
      rootB.render(
        createElement(CollabEditor, {
          hub,
          room,
          bootstrap: false,
          checklistPlugin: true,
          capture: (captured) => (capB = captured),
        }),
      )
    })
    await flush(capA!.provider, capB!.provider)

    const dueAt = '2026-08-16T09:00:00.000Z'
    act(() => {
      capA!.editor.update(
        () => {
          const item = $createListItemNode(false).append($createTextNode('Activate remotely'))
          $setChecklistTodoId(item, 'todo-remote-activation')
          $setChecklistSchedule(item, dueAt)
          $getRoot().clear().append($createListNode('check').append(item))
        },
        { discrete: true },
      )
    })
    await flush(capA!.provider, capB!.provider)

    const recurrence = createChecklistRecurrence('weekly', dueAt, 'UTC')!
    hub.pause()
    act(() => {
      capA!.editor.update(
        () => {
          const list = $getRoot().getFirstChild()
          const item = $isListNode(list) ? list.getFirstChild() : undefined
          if (!$isListItemNode(item)) {
            throw new Error('Expected editor A checklist item')
          }
          $setChecklistSchedule(item, dueAt, recurrence)
        },
        { discrete: true },
      )
      capB!.editor.update(
        () => {
          const list = $getRoot().getFirstChild()
          const item = $isListNode(list) ? list.getFirstChild() : undefined
          if (!$isListItemNode(item)) {
            throw new Error('Expected editor B checklist item')
          }
          $setChecklistItemChecked(item, true)
        },
        { discrete: true },
      )
    })
    await flush(capA!.provider, capB!.provider)
    hub.resume()
    await flush(capA!.provider, capB!.provider)

    const stateA = checklistState(capA!.editor)
    const stateB = checklistState(capB!.editor)
    expect(stateA).toEqual(stateB)
    expect(stateA.schedule).toMatchObject({ dueAt, recurrence: { frequency: 'weekly' } })
    expect(stateA.checked).toBe(false)

    await act(async () => {
      rootA!.unmount()
      rootB!.unmount()
    })
  })

  it('creates a fresh Y.Doc when the same note is closed and reopened', async () => {
    const hub = new LoopbackHub()
    const room = 'note-editor-reopen'
    const firstContainer = document.createElement('div')
    document.body.append(firstContainer)
    let first: Captured | undefined
    let firstRoot: Root

    await act(async () => {
      firstRoot = createRoot(firstContainer)
      firstRoot.render(
        createElement(CollabEditor, {
          hub,
          room,
          bootstrap: true,
          capture: (captured) => (first = captured),
        }),
      )
    })
    await flush(first!.provider)
    typeInto(first!.editor, 'state from the closed editor')
    await flush(first!.provider)
    const closedDocument = first!.provider.doc

    await act(async () => {
      firstRoot!.unmount()
      await Promise.resolve()
    })

    const reopenedContainer = document.createElement('div')
    document.body.append(reopenedContainer)
    let reopened: Captured | undefined
    let reopenedRoot: Root
    await act(async () => {
      reopenedRoot = createRoot(reopenedContainer)
      reopenedRoot.render(
        createElement(CollabEditor, {
          hub,
          room,
          bootstrap: true,
          initialText: 'fresh canonical state',
          capture: (captured) => (reopened = captured),
        }),
      )
    })
    await flush(reopened!.provider)

    expect(reopened!.provider.doc).not.toBe(closedDocument)
    expect(textOf(reopened!.editor)).toBe('fresh canonical state')
    expect(textOf(reopened!.editor)).not.toContain('state from the closed editor')

    await act(async () => {
      reopenedRoot!.unmount()
      await Promise.resolve()
    })
  })
})
