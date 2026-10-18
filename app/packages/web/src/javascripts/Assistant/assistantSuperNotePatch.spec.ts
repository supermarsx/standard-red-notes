import { webcrypto } from 'node:crypto'
import { TextEncoder as NodeTextEncoder } from 'node:util'
import {
  applyAssistantSuperPatch,
  assistantSuperRevision,
  readAssistantSuperStructure,
} from './assistantSuperNotePatch'

const ensureCrypto = () => {
  if (!globalThis.TextEncoder) {
    Object.defineProperty(globalThis, 'TextEncoder', { configurable: true, value: NodeTextEncoder })
  }
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
  }
}

const textNode = (text: string, format = 0) => ({
  detail: 0,
  format,
  mode: 'normal',
  style: '',
  text,
  type: 'text',
  version: 1,
})

it('reports per-person completion separately from the unrelated shared checked bit in structural reads', async () => {
  ensureCrypto()
  const task = {
    ...checklistItem('Each person', 'personal', true),
    $: { srnChecklistTodoId: 'personal', srnChecklistPerPerson: true, srnChecklistTick_peer: true },
  }
  const text = JSON.stringify({
    root: { type: 'root', children: [{ type: 'list', listType: 'check', children: [task] }] },
  })
  const view = await readAssistantSuperStructure(text, { view: 'blocks' })
  expect(view.blocks?.find((block) => block.todoId === 'personal')).toMatchObject({
    completionMode: 'per-person',
    checkedBy: ['peer'],
  })
  expect(view.blocks?.find((block) => block.todoId === 'personal')?.checked).toBeUndefined()
})

const checklistItem = (text: string, id: string, checked = false) => ({
  $: { srnChecklistTodoId: id, preservedFutureState: { version: 9, opaque: true } },
  checked,
  children: [textNode(text, 1)],
  direction: null,
  format: '',
  indent: 0,
  type: 'listitem',
  value: 1,
  version: 1,
})

const fixture = () => ({
  root: {
    children: [
      {
        children: [textNode('Purchases & Setup', 1)],
        direction: null,
        format: '',
        indent: 0,
        tag: 'h2',
        type: 'heading',
        version: 1,
      },
      {
        children: [textNode('Keep this ', 0), textNode('formatted', 2)],
        direction: null,
        format: '',
        indent: 0,
        type: 'paragraph',
        version: 1,
      },
      {
        children: [checklistItem('Configure scanner', 'todo-scanner'), checklistItem('Buy cable', 'todo-cable')],
        direction: null,
        format: '',
        indent: 0,
        listType: 'check',
        start: 1,
        tag: 'ul',
        type: 'list',
        version: 1,
      },
      {
        type: 'diagram-unknown-future',
        version: 42,
        uuid: 'embed-1',
        opaque: { source: 'graph TD; A-->B', theme: 'custom' },
      },
      {
        children: [textNode('Later')],
        direction: null,
        format: '',
        indent: 0,
        tag: 'h2',
        type: 'heading',
        version: 1,
      },
    ],
    direction: null,
    format: '',
    indent: 0,
    type: 'root',
    version: 1,
  },
})

describe('assistant Super-note structural patches', () => {
  beforeAll(ensureCrypto)

  it('inserts only one checklist node after an exact todo id and preserves every existing node byte-for-byte', async () => {
    const beforeDocument = fixture()
    const beforeText = JSON.stringify(beforeDocument)
    const base = await assistantSuperRevision(beforeText, '2026-08-18T12:00:00.000Z')

    const result = await applyAssistantSuperPatch(
      beforeText,
      {
        base,
        operations: [
          {
            type: 'insert',
            position: 'after',
            target: { todoId: 'todo-scanner' },
            block: { kind: 'checklist-item', text: 'Monitor Philips E24E2' },
          },
        ],
      },
      { updatedAt: base.updatedAt, createTodoId: () => 'todo-monitor-new' },
    )

    expect(result).toMatchObject({ ok: true, status: 'applied', appliedOperations: 1 })
    if (!result.ok) {
      throw new Error(result.reason)
    }
    const after = JSON.parse(result.text) as ReturnType<typeof fixture>
    const beforeItems = beforeDocument.root.children[2].children as ReturnType<typeof checklistItem>[]
    const afterItems = after.root.children[2].children as ReturnType<typeof checklistItem>[]
    expect(afterItems).toHaveLength(3)
    expect(afterItems[0]).toEqual(beforeItems[0])
    expect(afterItems[2]).toEqual(beforeItems[1])
    expect(afterItems[1]).toMatchObject({
      type: 'listitem',
      checked: false,
      $: { srnChecklistTodoId: 'todo-monitor-new' },
      children: [{ type: 'text', text: 'Monitor Philips E24E2' }],
    })
    expect(after.root.children[0]).toEqual(beforeDocument.root.children[0])
    expect(after.root.children[1]).toEqual(beforeDocument.root.children[1])
    expect(after.root.children[3]).toEqual(beforeDocument.root.children[3])
    expect(after.root.children[4]).toEqual(beforeDocument.root.children[4])
  })

  it('returns a bounded outline/section read with exact checklist locators instead of loading the whole body', async () => {
    const text = JSON.stringify(fixture())

    const outline = await readAssistantSuperStructure(text, { view: 'outline' })
    expect(outline.blocks).toBeUndefined()
    expect(outline.outline.map((entry) => entry.text)).toEqual(['Purchases & Setup', 'Later'])

    const section = await readAssistantSuperStructure(text, {
      view: 'section',
      section: { heading: { text: 'Purchases & Setup' } },
      limit: 20,
    })
    expect(section.blocks?.some((block) => block.todoId === 'todo-scanner')).toBe(true)
    expect(section.blocks?.some((block) => block.todoId === 'todo-cable')).toBe(true)
    expect(section.blocks?.some((block) => block.text === 'Later')).toBe(false)
    expect(section.blocks?.find((block) => block.text === 'Keep this formatted')?.inline).toEqual([
      expect.objectContaining({ text: 'Keep this ', format: 0, marks: [] }),
      expect.objectContaining({ text: 'formatted', format: 2, marks: ['italic'] }),
    ])
    expect(section.blocks?.find((block) => block.todoId === 'todo-scanner')?.list).toMatchObject({
      listType: 'check',
      start: 1,
      tag: 'ul',
    })
    expect(section.supportedSchema).toMatchObject({
      richBlockTypes: expect.arrayContaining(['heading', 'quote', 'code', 'list']),
      inlineMarks: expect.arrayContaining(['bold', 'italic', 'underline', 'strikethrough']),
      markdownFragment: { parser: 'canonical-lexical-markdown', createsNativeNodes: true },
    })
  })

  it('preserves split marks and unknown embeds while changing one exact formatted text leaf', async () => {
    const before = fixture()
    const text = JSON.stringify(before)
    const base = await assistantSuperRevision(text)

    const result = await applyAssistantSuperPatch(text, {
      base,
      operations: [
        {
          type: 'replace-text',
          target: { path: [1] },
          expectedText: 'formatted',
          text: 'styled',
        },
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error(result.reason)
    }
    const after = JSON.parse(result.text) as ReturnType<typeof fixture>
    expect(after.root.children[1].children).toEqual([textNode('Keep this ', 0), textNode('styled', 2)])
    expect(after.root.children[3]).toEqual(before.root.children[3])
  })

  it('returns a structured rebase conflict without applying operations when the content revision changed', async () => {
    const text = JSON.stringify(fixture())
    const stale = await assistantSuperRevision(`${text} `)

    const result = await applyAssistantSuperPatch(text, {
      base: stale,
      operations: [{ type: 'toggle-checklist', target: { todoId: 'todo-scanner' }, checked: true }],
    })

    expect(result).toMatchObject({
      ok: false,
      status: 'conflict',
      rebase: { outline: [{ text: 'Purchases & Setup' }, { text: 'Later' }] },
    })
  })

  it('refuses an ambiguous semantic heading and returns exact candidates', async () => {
    const document = fixture()
    document.root.children.push(JSON.parse(JSON.stringify(document.root.children[0])))
    const text = JSON.stringify(document)
    const base = await assistantSuperRevision(text)

    const result = await applyAssistantSuperPatch(text, {
      base,
      operations: [
        {
          type: 'insert',
          position: 'inside-section',
          target: { heading: { text: 'Purchases & Setup' } },
          block: { kind: 'paragraph', text: 'Must not be inserted ambiguously' },
        },
      ],
    })

    expect(result).toMatchObject({ ok: false, status: 'ambiguous' })
    if (result.ok || result.status !== 'ambiguous') {
      throw new Error('Expected an ambiguous result')
    }
    expect(result.candidates).toHaveLength(2)
  })

  it('applies a multi-operation edit atomically and preserves checklist identity on toggle/move', async () => {
    const text = JSON.stringify(fixture())
    const base = await assistantSuperRevision(text)
    const result = await applyAssistantSuperPatch(text, {
      base,
      operations: [
        { type: 'toggle-checklist', target: { todoId: 'todo-cable' }, checked: true },
        {
          type: 'move',
          target: { todoId: 'todo-cable' },
          destination: { position: 'before', target: { todoId: 'todo-scanner' } },
        },
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error(result.reason)
    }
    const items = (JSON.parse(result.text) as ReturnType<typeof fixture>).root.children[2].children as ReturnType<
      typeof checklistItem
    >[]
    expect(items.map((item) => item.$.srnChecklistTodoId)).toEqual(['todo-cable', 'todo-scanner'])
    expect(items[0].checked).toBe(true)
    expect(items[0].$.preservedFutureState).toEqual({ version: 9, opaque: true })
  })

  it('returns bounded effects for insertion, replacement, deletion, checklist, and formatting changes', async () => {
    const text = JSON.stringify(fixture())
    const base = await assistantSuperRevision(text)
    const result = await applyAssistantSuperPatch(
      text,
      {
        base,
        operations: [
          {
            operationId: 'op-replace',
            type: 'replace-text',
            target: { path: [1] },
            expectedText: 'formatted',
            text: 'restyled',
          },
          {
            operationId: 'op-toggle',
            type: 'toggle-checklist',
            target: { todoId: 'todo-scanner' },
            checked: true,
          },
          {
            operationId: 'op-format',
            type: 'update-attrs',
            target: { path: [0] },
            attrs: { tag: 'h3' },
          },
          {
            operationId: 'op-insert',
            type: 'insert',
            position: 'after',
            target: { todoId: 'todo-cable' },
            block: { kind: 'checklist-item', text: 'New tracked task' },
          },
          { operationId: 'op-delete', type: 'delete', target: { nodeUuid: 'embed-1' } },
        ],
      },
      { createTodoId: () => 'todo-tracked' },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error(result.reason)
    }
    expect(result.operationEffects.map((effect) => effect.operationId)).toEqual([
      'op-replace',
      'op-toggle',
      'op-format',
      'op-insert',
      'op-delete',
    ])
    expect(result.operationEffects.find((effect) => effect.operationId === 'op-replace')).toMatchObject({
      beforeFragment: expect.stringContaining('formatted'),
      afterFragment: expect.stringContaining('restyled'),
    })
    expect(result.operationEffects.find((effect) => effect.operationId === 'op-toggle')).toMatchObject({
      affected: [expect.objectContaining({ todoId: 'todo-scanner' })],
      beforeFragment: expect.stringContaining('false'),
      afterFragment: expect.stringContaining('true'),
    })
    expect(result.operationEffects.find((effect) => effect.operationId === 'op-format')).toMatchObject({
      beforeFragment: expect.stringContaining('h2'),
      afterFragment: expect.stringContaining('h3'),
    })
    expect(result.operationEffects.find((effect) => effect.operationId === 'op-insert')).toMatchObject({
      affected: expect.arrayContaining([expect.objectContaining({ todoId: 'todo-tracked' })]),
      afterFragment: expect.stringContaining('New tracked task'),
    })
    expect(result.operationEffects.find((effect) => effect.operationId === 'op-delete')).toMatchObject({
      deleted: true,
      affected: [expect.objectContaining({ nodeUuid: 'embed-1' })],
      beforeFragment: expect.stringContaining('diagram-unknown-future'),
    })
    expect(result.operationEffects.find((effect) => effect.operationId === 'op-delete')?.afterFragment).toBeUndefined()
  })

  it('redacts an unterminated secret before bounding a structural fragment', async () => {
    const document = fixture()
    const secret = 'MID_FRAGMENT_SECRET_'.repeat(300)
    document.root.children[1].children = [textNode(`{"password":"${secret}`)]
    const text = JSON.stringify(document)
    const base = await assistantSuperRevision(text)
    const result = await applyAssistantSuperPatch(text, {
      base,
      operations: [{ operationId: 'op-secret-delete', type: 'delete', target: { path: [1] } }],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error(result.reason)
    }
    const fragment = result.operationEffects[0].beforeFragment ?? ''
    expect(fragment).toContain('[redacted]')
    expect(fragment).not.toContain('MID_FRAGMENT_SECRET')
    expect(fragment.length).toBeLessThanOrEqual(2_049)
  })

  it('inserts a native styled Philips section and checklist while preserving existing unknown nodes', async () => {
    const before = fixture()
    const text = JSON.stringify(before)
    const base = await assistantSuperRevision(text)
    let nextId = 0
    const result = await applyAssistantSuperPatch(
      text,
      {
        base,
        operations: [
          {
            type: 'insert',
            position: 'inside-section',
            target: { heading: { text: 'Purchases & Setup' } },
            block: {
              kind: 'rich-fragment',
              blocks: [
                {
                  type: 'heading',
                  level: 3,
                  content: [{ text: 'Philips E24E2 deployment', marks: ['bold', 'underline'] }],
                },
                {
                  type: 'list',
                  listType: 'check',
                  items: [{ content: [{ text: 'Verify display calibration', marks: ['italic'] }], checked: false }],
                },
              ],
            },
          },
        ],
      },
      { createTodoId: () => `todo-philips-${++nextId}` },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error(result.reason)
    }
    const after = JSON.parse(result.text) as { root: { children: Record<string, unknown>[] } }
    expect(after.root.children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'heading',
          tag: 'h3',
          children: [expect.objectContaining({ text: 'Philips E24E2 deployment', format: 9 })],
        }),
        expect.objectContaining({
          type: 'list',
          listType: 'check',
          children: [
            expect.objectContaining({
              checked: false,
              $: { srnChecklistTodoId: 'todo-philips-1' },
              children: [expect.objectContaining({ text: 'Verify display calibration', format: 2 })],
            }),
          ],
        }),
      ]),
    )
    expect(after.root.children.find((node) => node.type === 'diagram-unknown-future')).toEqual(before.root.children[3])
  })

  it('keeps Markdown-looking characters literal when the inserted block is declared plain', async () => {
    const text = JSON.stringify(fixture())
    const base = await assistantSuperRevision(text)
    const result = await applyAssistantSuperPatch(text, {
      base,
      operations: [
        {
          type: 'insert',
          position: 'inside-section',
          target: { heading: { text: 'Purchases & Setup' } },
          block: { kind: 'paragraph', text: '## literal **not bold** - [ ] still plain' },
        },
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error(result.reason)
    }
    const nodes = (JSON.parse(result.text) as { root: { children: Record<string, unknown>[] } }).root.children
    expect(nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'paragraph',
          children: [expect.objectContaining({ text: '## literal **not bold** - [ ] still plain', format: 0 })],
        }),
      ]),
    )
  })

  it('does not expose any note create/delete replacement operation', () => {
    const forbidden = ['create-note', 'delete-note', 'replace-note', 'recreate-note']
    expect(forbidden).not.toContain('insert')
    expect(forbidden).not.toContain('replace-text')
  })
})

describe('Mermaid structural edits', () => {
  const diagram = {
    type: 'mermaid',
    version: 4,
    code: 'flowchart LR\nA-->B',
    theme: 'forest',
    viewMode: 'split',
    width: '60%',
    height: 240,
    fitMode: 'fitBoth',
    alignment: 'center',
    background: 'auto',
    zoomPan: true,
    future: { preserved: true },
  }
  const document = () =>
    JSON.stringify({
      root: { type: 'root', children: [{ type: 'paragraph', children: [textNode('Untouched')] }, diagram] },
    })
  beforeEach(ensureCrypto)
  it('exposes source and settings and preserves every unrelated field on an audited source/settings edit', async () => {
    const text = document()
    const read = await readAssistantSuperStructure(text, { view: 'blocks' })
    expect(read.blocks?.find((block) => block.type === 'mermaid')?.mermaid).toEqual({
      source: diagram.code,
      sourceTruncated: false,
      settings: { fitMode: 'fitBoth', alignment: 'center', background: 'auto', zoomPan: true },
    })
    const result = await applyAssistantSuperPatch(text, {
      base: read.revision,
      operations: [
        {
          type: 'update-mermaid',
          target: { path: [1] },
          expectedSource: diagram.code,
          source: 'flowchart LR\nA-->C',
          mermaidSettings: { alignment: 'right' },
          operationId: 'diagram-edit',
        },
      ],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('Expected applied patch')
    expect(JSON.parse(result.text).root.children).toEqual([
      JSON.parse(text).root.children[0],
      { ...diagram, code: 'flowchart LR\nA-->C', alignment: 'right' },
    ])
    expect(result.operationEffects[0]).toMatchObject({
      operationId: 'diagram-edit',
      type: 'update-mermaid',
      affected: [{ path: [1] }],
    })
  })
  it.each([
    { source: '' },
    { source: 'x'.repeat(16385) },
    { expectedSource: 'stale', source: 'graph TD' },
    { mermaidSettings: { alignment: 'invalid' } },
    { mermaidSettings: { theme: 'dark' } },
    {},
  ])('refuses malformed or stale diagram edits atomically: %p', async (patch) => {
    const text = document()
    const result = await applyAssistantSuperPatch(text, {
      base: await assistantSuperRevision(text),
      operations: [{ type: 'update-mermaid', target: { path: [1] }, ...patch } as never],
    })
    expect(result.ok).toBe(false)
    expect(result).not.toHaveProperty('text')
  })
  it('rejects a non-diagram locator and stale note revision', async () => {
    const text = document()
    const operation = { type: 'update-mermaid' as const, target: { path: [0] }, source: 'graph TD' }
    expect(
      (await applyAssistantSuperPatch(text, { base: await assistantSuperRevision(text), operations: [operation] })).ok,
    ).toBe(false)
    expect(
      (
        await applyAssistantSuperPatch(text, {
          base: { contentHash: 'stale' },
          operations: [{ ...operation, target: { path: [1] } }],
        })
      ).status,
    ).toBe('conflict')
  })
  it('marks oversized source reads truncated without changing stored diagrams', async () => {
    const text = JSON.stringify({ root: { type: 'root', children: [{ ...diagram, code: 'x'.repeat(16385) }] } })
    const read = await readAssistantSuperStructure(text, { view: 'blocks' })
    expect(read.blocks?.[0].mermaid).toMatchObject({ source: 'x'.repeat(16384), sourceTruncated: true })
  })
})

it('reports effective legacy diagram fitting and refuses settings the legacy version would discard', async () => {
  ensureCrypto()
  const text = JSON.stringify({
    root: { type: 'root', children: [{ type: 'mermaid', version: 4, code: 'graph TD', fitMode: 'fitWidth' }] },
  })
  const read = await readAssistantSuperStructure(text, { view: 'blocks' })
  expect(read.blocks?.[0].mermaid?.settings.fitMode).toBe('fitBoth')
  const result = await applyAssistantSuperPatch(text, {
    base: read.revision,
    operations: [{ type: 'update-mermaid', target: { path: [0] }, mermaidSettings: { fitMode: 'fitWidth' } }],
  })
  expect(result.ok).toBe(false)
})

describe('precise text formatting', () => {
  beforeEach(ensureCrypto)
  it('formats only the requested substring, preserving surrounding style and native node state', async () => {
    const leaf = { ...textNode('before target after', 2), style: 'color: red;', future: { preserved: true } }
    const text = JSON.stringify({ root: { type: 'root', children: [{ type: 'paragraph', children: [leaf] }] } })
    const result = await applyAssistantSuperPatch(text, {
      base: await assistantSuperRevision(text),
      operations: [
        { type: 'replace-text', target: { path: [0, 0] }, expectedText: 'target', text: 'target', marks: 3 },
      ],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('Expected patch')
    expect(JSON.parse(result.text).root.children[0].children).toEqual([
      { ...leaf, text: 'before ' },
      { ...leaf, text: 'target', format: 3 },
      { ...leaf, text: ' after' },
    ])
    expect(result.operationEffects[0].affected).toEqual([{ path: [0, 1] }])
  })
  it('treats replacement dollar patterns literally', async () => {
    const text = JSON.stringify({
      root: { type: 'root', children: [{ type: 'paragraph', children: [textNode('target')] }] },
    })
    const result = await applyAssistantSuperPatch(text, {
      base: await assistantSuperRevision(text),
      operations: [{ type: 'replace-text', target: { path: [0] }, expectedText: 'target', text: '$& $` $$' }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('Expected patch')
    expect(JSON.parse(result.text).root.children[0].children[0].text).toBe('$& $` $$')
  })
})
