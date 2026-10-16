/** @jest-environment jsdom */
import {
  createEditor,
  $createTextNode,
  $createParagraphNode,
  $getRoot,
  $createRangeSelection,
  $setSelection,
} from 'lexical'
import { HeadingNode, $createHeadingNode } from '@lexical/rich-text'
import { captureLexicalCommentTarget } from './LexicalCommentTargets'

function editorFixture() {
  const editor = createEditor({
    namespace: 'comment-target-test',
    nodes: [HeadingNode],
    onError: (error) => {
      throw error
    },
  })
  const element = document.createElement('div')
  document.body.appendChild(element)
  editor.setRootElement(element)
  editor.update(
    () => {
      const one = $createHeadingNode('h2').append($createTextNode('First section'))
      const bodyText = $createTextNode('Alpha beta')
      const body = $createParagraphNode().append(bodyText)
      const sub = $createHeadingNode('h3').append($createTextNode('Nested section'))
      const subBody = $createParagraphNode().append($createTextNode('Nested content'))
      const two = $createHeadingNode('h2').append($createTextNode('Second section'))
      $getRoot().append(one, body, sub, subBody, two)
      bodyText.select(0, 5)
    },
    { discrete: true },
  )
  return {
    editor,
    dispose() {
      editor.setRootElement(null)
      element.remove()
    },
  }
}

it('captures the exact real selection offsets and quote, rejecting any subsequent document edit', () => {
  const h = editorFixture()
  try {
    const captured = captureLexicalCommentTarget(h.editor, 'selection')
    expect(captured.anchor).toMatchObject({
      kind: 'super',
      target: 'selection',
      exactRange: { start: 15, end: 20, text: 'Alpha' },
    })
    expect(() => captured.assertCurrent()).not.toThrow()
    h.editor.update(
      () => {
        $getRoot().append($createParagraphNode().append($createTextNode('Later edit')))
      },
      { discrete: true },
    )
    expect(() => captured.assertCurrent()).toThrow('note changed')
  } finally {
    h.dispose()
  }
})

it('captures the current heading section through nested headings but stops before the next peer', () => {
  const h = editorFixture()
  try {
    const anchor = captureLexicalCommentTarget(h.editor, 'section').anchor
    expect(anchor?.kind).toBe('super')
    if (anchor?.kind !== 'super') throw new Error('Missing range')
    expect(anchor.target).toBe('section')
    expect(anchor.exactRange?.text).toContain('First section')
    expect(anchor.exactRange?.text).toContain('Nested content')
    expect(anchor.exactRange?.text).not.toContain('Second section')
  } finally {
    h.dispose()
  }
})

it('captures a reversed multi-block selection from real node positions without a fuzzy text lookup', () => {
  const h = editorFixture()
  try {
    h.editor.update(
      () => {
        const blocks = $getRoot().getChildren()
        const selection = $createRangeSelection()
        const first = blocks[1] as ReturnType<typeof $createParagraphNode>
        const last = blocks[3] as ReturnType<typeof $createParagraphNode>
        selection.anchor.set(last.getFirstChild()!.getKey(), 6, 'text')
        selection.focus.set(first.getFirstChild()!.getKey(), 6, 'text')
        $setSelection(selection)
      },
      { discrete: true },
    )
    const anchor = captureLexicalCommentTarget(h.editor, 'selection').anchor
    expect(anchor).toMatchObject({
      kind: 'super',
      target: 'selection',
      exactRange: { text: 'beta\n\nNested section\n\nNested' },
    })
  } finally {
    h.dispose()
  }
})

it('does not demand a shared socket saver for private comments, and refuses empty selection targets', () => {
  const h = editorFixture()
  try {
    h.editor.setEditable(false)
    const captured = captureLexicalCommentTarget(h.editor, 'note')
    expect(() => captured.assertCurrent({ sharedMutation: false })).not.toThrow()
    expect(() => captured.assertCurrent({ sharedMutation: true })).toThrow('socket saver')
    h.editor.update(
      () => {
        $getRoot().getFirstChild()!.selectStart()
      },
      { discrete: true },
    )
    expect(() => captureLexicalCommentTarget(h.editor, 'selection')).toThrow('nonempty')
  } finally {
    h.dispose()
  }
})
