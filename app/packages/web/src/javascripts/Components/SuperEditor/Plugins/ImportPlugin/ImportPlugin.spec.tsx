/** @jest-environment jsdom */

/**
 * The OTHER markdown import path: the editor plugin that converts a note in
 * place when its type changes. It runs the same transformer as
 * `HeadlessSuperConverter`, so it needs the same indent normalisation — a
 * two-space nested list arriving here used to half-flatten exactly as it did
 * there, and a unit test of the helper cannot prove this call site uses it.
 *
 * Rendered with react-dom/client + `act` (this package has no
 * @testing-library/react), and the assertion reads the editor state the plugin
 * actually produced rather than the plugin's `onChange`, whose update listener
 * is registered after the conversion has already been queued.
 */

// ImportPlugin reads one constant from `SuperEditor.tsx`, which pulls the whole
// editor (and browser-only globals) in behind it. Only the constant is needed.
jest.mock('../../SuperEditor', () => ({ SuperNotePreviewCharLimit: 160 }))

import { act } from 'react'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import type { LexicalEditor } from 'lexical'
import { createRoot } from 'react-dom/client'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import BlocksEditorTheme from '../../Lexical/Theme/Theme'
import { BlockEditorNodes } from '../../Lexical/Nodes/AllNodes'
import ImportPlugin from './ImportPlugin'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type SerializedNode = { type?: string; children?: SerializedNode[]; text?: string; checked?: boolean }

/** `{ text, depth }` for every real row, skipping Lexical nesting wrappers. */
const rowsOf = (superString: string): { text: string; depth: number; checked?: boolean }[] => {
  const rows: { text: string; depth: number; checked?: boolean }[] = []
  const ownText = (node: SerializedNode): string =>
    (node.children ?? [])
      .filter((child) => child.type !== 'list')
      .map((child) => (child.type === 'text' ? (child.text ?? '') : ownText(child)))
      .join('')
  const walk = (node: SerializedNode, depth: number): void => {
    for (const child of node.children ?? []) {
      if (child.type === 'list') {
        walk(child, depth + 1)
        continue
      }
      if (child.type === 'listitem' || child.type === 'checklist-item') {
        const children = child.children ?? []
        const nested = children.filter((grandChild) => grandChild.type === 'list')
        if (!(children.length > 0 && nested.length === children.length)) {
          rows.push({ text: ownText(child), depth, checked: child.checked })
        }
        for (const branch of nested) {
          walk(branch, depth + 1)
        }
        continue
      }
      walk(child, depth)
    }
  }
  walk((JSON.parse(superString) as { root: SerializedNode }).root, -1)
  return rows
}

const importMarkdown = async (markdown: string): Promise<string> => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  let editor: LexicalEditor | undefined

  const CaptureEditor = (): null => {
    const [contextEditor] = useLexicalComposerContext()
    editor = contextEditor
    return null
  }

  await act(async () => {
    root.render(
      <LexicalComposer
        initialConfig={{
          namespace: 'BlocksEditor',
          theme: BlocksEditorTheme,
          editable: false,
          nodes: BlockEditorNodes,
          onError: (error: Error) => {
            throw error
          },
        }}
      >
        <CaptureEditor />
        <ImportPlugin text={markdown} format="md" onChange={() => undefined} />
      </LexicalComposer>,
    )
  })

  if (!editor) {
    throw new Error('the composer never handed over an editor')
  }
  const superString = JSON.stringify(editor.getEditorState().toJSON())

  await act(async () => {
    root.unmount()
  })
  container.remove()
  return superString
}

describe('ImportPlugin markdown nesting', () => {
  beforeAll(() => {
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
  })

  it('keeps all four levels of a two-space nested checklist', async () => {
    const rows = rowsOf(await importMarkdown(['- [ ] a', '  - [x] b', '    - [ ] c', '      - [x] d', ''].join('\n')))
    expect(rows).toEqual([
      { text: 'a', depth: 0, checked: false },
      { text: 'b', depth: 1, checked: true },
      { text: 'c', depth: 2, checked: false },
      { text: 'd', depth: 3, checked: true },
    ])
  })

  it('leaves a four-space nested checklist exactly as deep as it was', async () => {
    const rows = rowsOf(
      await importMarkdown(['- [ ] a', '    - [x] b', '        - [ ] c', '            - [x] d', ''].join('\n')),
    )
    expect(rows.map((item) => item.depth)).toEqual([0, 1, 2, 3])
  })
})
