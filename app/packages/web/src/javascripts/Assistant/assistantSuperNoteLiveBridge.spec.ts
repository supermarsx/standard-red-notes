import { webcrypto } from 'node:crypto'
import { TextEncoder as NodeTextEncoder } from 'node:util'
import {
  getAssistantSuperNoteLiveBridge,
  prepareAssistantLiveSuperPatch,
  readAssistantLiveSuperStructure,
  registerAssistantSuperNoteLiveBridge,
} from './assistantSuperNoteLiveBridge'

const document = {
  root: {
    children: [
      {
        children: [{ detail: 0, format: 0, mode: 'normal', style: '', text: 'Section', type: 'text', version: 1 }],
        direction: null,
        format: '',
        indent: 0,
        tag: 'h2',
        type: 'heading',
        version: 1,
      },
      {
        children: [{ detail: 0, format: 0, mode: 'normal', style: '', text: 'Body', type: 'text', version: 1 }],
        direction: null,
        format: '',
        indent: 0,
        type: 'paragraph',
        version: 1,
      },
    ],
    direction: null,
    format: '',
    indent: 0,
    type: 'root',
    version: 1,
  },
}

describe('assistant live Super bridge', () => {
  beforeAll(() => {
    if (!globalThis.TextEncoder) {
      Object.defineProperty(globalThis, 'TextEncoder', { configurable: true, value: NodeTextEncoder })
    }
    if (!globalThis.crypto?.subtle) {
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
    }
  })

  it('promotes serialized paths to live Lexical node keys and resolves them for the same revision', async () => {
    const text = JSON.stringify(document)
    const snapshot = {
      text,
      pathsByNodeKey: new Map([
        ['root', []],
        ['heading-key', [0]],
        ['heading-text-key', [0, 0]],
        ['paragraph-key', [1]],
        ['paragraph-text-key', [1, 0]],
      ]),
    }
    const read = await readAssistantLiveSuperStructure(snapshot, { view: 'blocks' })
    expect(read.outline[0].locator).toEqual({ nodeKey: 'heading-key' })
    expect(read.blocks?.find((block) => block.text === 'Body')?.locator).toEqual({ nodeKey: 'paragraph-key' })

    const result = await prepareAssistantLiveSuperPatch(snapshot, {
      base: read.revision,
      operations: [
        {
          type: 'replace-text',
          target: { nodeKey: 'paragraph-key' },
          expectedText: 'Body',
          text: 'Updated body',
        },
      ],
    })
    expect(result).toMatchObject({ ok: true, status: 'applied' })
    if (result.ok) {
      expect(JSON.parse(result.text).root.children[1].children[0].text).toBe('Updated body')
    }
  })

  it('keeps a newer bridge registered when an older React lifetime disposes', () => {
    const oldBridge = { read: jest.fn(), preparePatch: jest.fn() }
    const newBridge = { read: jest.fn(), preparePatch: jest.fn() }
    const disposeOld = registerAssistantSuperNoteLiveBridge('note-a', oldBridge)
    const disposeNew = registerAssistantSuperNoteLiveBridge('note-a', newBridge)

    expect(getAssistantSuperNoteLiveBridge('note-a')).toBe(newBridge)
    disposeOld()
    expect(getAssistantSuperNoteLiveBridge('note-a')).toBe(newBridge)
    disposeNew()
    expect(getAssistantSuperNoteLiveBridge('note-a')).toBeUndefined()
  })
})
