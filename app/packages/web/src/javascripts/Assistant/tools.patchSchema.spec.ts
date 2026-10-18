import Ajv from 'ajv'
import { TOOL_DEFINITIONS } from './tools'
jest.mock('@/Components/SuperEditor/Tools/HeadlessSuperConverter', () => ({ HeadlessSuperConverter: class {} }))
const schema = TOOL_DEFINITIONS.find((tool) => tool.name === 'notes.patchBlocks')!.inputSchema as object
const validate = new Ajv({ strict: false }).compile(schema)
const payload = (operation: unknown) => ({ uuid: 'note', base: { contentHash: 'current' }, operations: [operation] })
it.each([
  {
    type: 'insert',
    target: { path: [0] },
    position: 'after',
    block: { kind: 'markdown-fragment', markdown: '## Heading' },
  },
  {
    type: 'insert',
    target: { heading: { text: 'Tasks', occurrence: 2 } },
    position: 'inside-section',
    block: { kind: 'checklist-item', text: 'Task', checked: false },
  },
  { type: 'replace-text', target: { nodeKey: 'key' }, expectedText: 'word', text: 'word', marks: 3 },
  { type: 'toggle-checklist', target: { todoId: 'task' }, checked: true },
  { type: 'move', target: { nodeUuid: 'a' }, destination: { position: 'after', target: { nodeUuid: 'b' } } },
  { type: 'delete', target: { path: [2] } },
  { type: 'update-attrs', target: { path: [0] }, attrs: { format: 1, direction: null } },
  { type: 'update-mermaid', target: { path: [0] }, source: 'graph TD' },
  { type: 'update-mermaid', target: { path: [0] }, mermaidSettings: { alignment: 'left' } },
  {
    type: 'insert',
    target: { path: [0] },
    position: 'after',
    block: {
      kind: 'rich-fragment',
      blocks: [
        {
          type: 'list',
          listType: 'check',
          items: [
            {
              content: [{ text: 'Task', marks: ['bold'] }],
              children: { listType: 'bullet', items: [{ content: [{ text: 'nested' }] }] },
            },
          ],
        },
      ],
    },
  },
])('accepts documented operation %p', (operation) => {
  expect(validate(payload(operation))).toBe(true)
})
it.each([
  { type: 'insert', target: { path: [0] }, position: 'after', markdown: 'wrong location' },
  { type: 'insert', target: { path: [0] }, block: { kind: 'paragraph', text: 'missing position' } },
  {
    type: 'insert',
    target: { path: [0] },
    position: 'after',
    block: { kind: 'markdown-fragment', text: 'wrong field' },
  },
  { type: 'move', target: { path: [0] }, destination: { path: [1] } },
  { type: 'move', target: { path: [0] }, destination: { position: 'after', target: '1' } },
  { type: 'replace-text', target: { path: [0] }, text: 'missing expectedText' },
  { type: 'replace-text', target: { path: [0] }, expectedText: 'before', replacement: 'after' },
  { type: 'delete', target: {} },
  { type: 'delete', target: { path: [0], todoId: 'ambiguous' } },
  { type: 'toggle-checklist', target: { path: [0] } },
  { type: 'update-mermaid', target: { path: [0] }, expectedSource: 'not a change' },
  { type: 'update-mermaid', target: { path: [0] }, mermaidSettings: { script: 'unsafe' } },
  {
    type: 'insert',
    target: { path: [0] },
    position: 'after',
    block: {
      kind: 'rich-fragment',
      blocks: [{ type: 'list', listType: 'check', items: [{ text: 'missing content runs' }] }],
    },
  },
])('rejects guessed or incomplete operation %p', (operation) => {
  expect(validate(payload(operation))).toBe(false)
})
it('keeps an object tool root and bounded operations', () => {
  expect(schema).toMatchObject({ type: 'object', required: ['uuid', 'base', 'operations'] })
  expect(validate({ uuid: 'note', base: {}, operations: [{ type: 'delete', target: { path: [0] } }] })).toBe(false)
})

it('bounds schema serialization', () => {
  const size = JSON.stringify(schema).length
  expect(size).toBeLessThan(65536)
})
