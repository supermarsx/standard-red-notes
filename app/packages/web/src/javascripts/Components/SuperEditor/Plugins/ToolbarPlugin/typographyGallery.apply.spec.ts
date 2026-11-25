/** @jest-environment jsdom */
import { createHeadlessEditor } from '@lexical/headless'
import {
  registerList,
  registerCheckList,
  ListNode,
  ListItemNode,
  $createListNode,
  $createListItemNode,
} from '@lexical/list'
import { CodeNode } from '@lexical/code'
import { HeadingNode, QuoteNode } from '@lexical/rich-text'
import { $createLinkNode, LinkNode } from '@lexical/link'
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $createRangeSelection,
  $setSelection,
  createEditor,
  $nodesOfType,
  UNDO_COMMAND,
  SKIP_DOM_SELECTION_TAG,
} from 'lexical'
import { createEmptyHistoryState, registerHistory } from '@lexical/history'
import { DEFAULT_TYPOGRAPHY_PROFILE, TypographyProfile } from '@standardnotes/models'
import { STYLED_BLOCK_NODE_OVERRIDES } from '../../Lexical/Nodes/StyledBlockNodes'
import { applyTypographyBlockToSelection, GALLERY_BLOCKS } from './typographyGallery'
import { parseStyleString, $setSpaceBefore } from './blockFormatting'
import { $readBlockStyle } from './persistedBlockStyle'
import { registerNativeBlockStyles } from '../BlockStylePlugin'
import { $getListStyle, $setCustomListStyle } from './listStyle'

const makeEditor = () =>
  createHeadlessEditor({
    namespace: 'full-style-application',
    nodes: [HeadingNode, QuoteNode, ...STYLED_BLOCK_NODE_OVERRIDES, ListNode, ListItemNode, LinkNode, CodeNode],
    onError: (error) => {
      throw error
    },
  })
const style = (key: string) => GALLERY_BLOCKS.find((descriptor) => descriptor.key === key)!
const apply = async (editor: ReturnType<typeof makeEditor>, key: string, profile: TypographyProfile | null = null) => {
  applyTypographyBlockToSelection(editor, style(key), profile)
  await Promise.resolve()
  editor.update(() => undefined, { discrete: true })
}

it('replaces the entire prior paragraph style, inline formatting, alignment and indent with the chosen style', async () => {
  const editor = makeEditor()
  editor.update(
    () => {
      const text = $createTextNode('Keep these words')
        .setFormat('italic')
        .setStyle('font-size: 40px; color: red; background-color: yellow;')
      const block = $createParagraphNode()
        .setStyle('font-size: 40px; font-style: italic; color: red; border-left: 8px solid red; margin-bottom: 30px;')
        .setFormat('right')
        .setIndent(3)
        .append(text)
      $getRoot().append(block)
      text.select(3, 3)
    },
    { discrete: true },
  )
  const profile: TypographyProfile = {
    ...DEFAULT_TYPOGRAPHY_PROFILE,
    blocks: { strong: { fontSize: '18px', color: '#123456', textAlign: 'center', marginTop: '8px' } },
  }
  await apply(editor, 'strong', profile)
  editor.getEditorState().read(() => {
    const block = $getRoot().getFirstChild()!
    expect($isElementNode(block)).toBe(true)
    if (!$isElementNode(block)) {
      return
    }
    expect(parseStyleString(block.getStyle())).toEqual(
      new Map([
        ['margin-top', '8px'],
        ['font-size', '18px'],
        ['font-weight', '700'],
        ['color', '#123456'],
        ['text-align', 'center'],
      ]),
    )
    expect(block.getFormatType()).toBe('')
    expect(block.getIndent()).toBe(0)
    const text = block.getFirstDescendant()!
    expect($isTextNode(text) && text.getFormat()).toBe(0)
    expect($isTextNode(text) && text.getStyle()).not.toContain('40px')
    const selection = $getSelection()
    expect($isRangeSelection(selection) && selection.anchor.offset).toBe(3)
    expect(block.getTextContent()).toBe('Keep these words')
  })
})

it('returns to inherited Normal formatting even when Normal has no explicit overrides', async () => {
  const editor = makeEditor()
  editor.update(
    () => {
      const text = $createTextNode('A paragraph').setFormat('bold').setStyle('color: red;')
      $getRoot().append(
        $createParagraphNode().append(text).setStyle('font-size: 2rem; font-weight: 800; border: 2px solid red;'),
      )
      text.select(0, 3)
    },
    { discrete: true },
  )
  await apply(editor, 'paragraph')
  editor.getEditorState().read(() => {
    const block = $getRoot().getFirstChild()!
    expect($isElementNode(block) && block.getStyle()).toBe('')
    const text = $isElementNode(block) ? block.getFirstDescendant() : null
    expect($isTextNode(text) && text.getFormat()).toBe(0)
    const selection = $getSelection()
    expect($isRangeSelection(selection) && selection.style).toBe('')
  })
})

it('preserves links, text and unselected paragraphs while restyling the complete selected block', async () => {
  const editor = makeEditor()
  editor.update(
    () => {
      const before = $createTextNode('Before ').setFormat('bold')
      const link = $createLinkNode('https://example.test').append($createTextNode('linked').setFormat('italic'))
      const after = $createTextNode(' after').setStyle('font-size: 40px;')
      $getRoot().append(
        $createParagraphNode().append(before, link, after),
        $createParagraphNode().append($createTextNode('Untouched').setFormat('bold')),
      )
      before.select(2, 4)
    },
    { discrete: true },
  )
  await apply(editor, 'emphasis')
  editor.getEditorState().read(() => {
    expect($getRoot().getFirstChild()!.getTextContent()).toBe('Before linked after')
    const block = $getRoot().getFirstChild()!
    expect($isElementNode(block) && block.getChildren()[1] instanceof LinkNode).toBe(true)
    expect($isElementNode(block) && block.getAllTextNodes().every((text) => text.getFormat() === 0)).toBe(true)
    const last = $getRoot().getLastChild()
    const untouched = $isElementNode(last) ? last.getFirstDescendant() : null
    expect($isTextNode(untouched) && untouched.hasFormat('bold')).toBe(true)
  })
})

it('does not change the block type or text when the editor is read-only', async () => {
  const editor = makeEditor()
  editor.update(
    () => {
      const text = $createTextNode('Read only')
      $getRoot().append($createParagraphNode().append(text))
      text.select(0, 0)
    },
    { discrete: true },
  )
  const before = editor.getEditorState().toJSON()
  editor.setEditable(false)
  await apply(editor, 'h1')
  expect(editor.getEditorState().toJSON()).toEqual(before)
})

it.each(['bulletList', 'numberedList', 'checkList', 'code'] as const)(
  'restores the complete %s styling in real DOM after JSON reload',
  async (key) => {
    const editor = createEditor({
      nodes: [HeadingNode, QuoteNode, ...STYLED_BLOCK_NODE_OVERRIDES, ListNode, ListItemNode, CodeNode],
      onError: (error) => {
        throw error
      },
    })
    const stopList = registerList(editor)
    const stopCheckList = registerCheckList(editor)
    editor.update(
      () => {
        const text = $createTextNode('Saved styling')
        $getRoot().append($createParagraphNode().append(text))
        text.select(1, 1)
      },
      { discrete: true },
    )
    await apply(editor, key, {
      ...DEFAULT_TYPOGRAPHY_PROFILE,
      blocks: {
        [key]: {
          fontSize: '22px',
          color: '#123456',
          lineHeight: '1.75',
          marginBottom: '12px',
          borderStyle: 'dashed',
          borderWidth: '2px',
          markerColor: '#456789',
        },
      },
    })
    const container = document.createElement('div')
    container.contentEditable = 'true'
    document.body.append(container)
    const reopened = createEditor({
      nodes: [HeadingNode, QuoteNode, ...STYLED_BLOCK_NODE_OVERRIDES, ListNode, ListItemNode, CodeNode],
      onError: (error) => {
        throw error
      },
    })
    reopened.setRootElement(container)
    const stopStyles = registerNativeBlockStyles(reopened)
    reopened.setEditorState(reopened.parseEditorState(JSON.stringify(editor.getEditorState().toJSON())))
    reopened.update(() => undefined, { discrete: true })
    try {
      reopened.getEditorState().read(() => {
        const node = (key === 'code' ? $nodesOfType(CodeNode)[0] : $nodesOfType(ListItemNode)[0])!
        expect(node).toBeDefined()
        expect(parseStyleString($readBlockStyle(node)).get('font-size')).toBe('22px')
        const element = reopened.getElementByKey(node.getKey())!
        expect(element.style.fontSize).toBe('22px')
        expect(element.style.lineHeight).toBe('1.75')
        expect(element.style.marginBottom).toBe('12px')
        expect(element.style.borderStyle).toBe('dashed')
        expect(element.textContent).toBe('Saved styling')
      })
      reopened.update(
        () => {
          const node = (key === 'code' ? $nodesOfType(CodeNode)[0] : $nodesOfType(ListItemNode)[0])!
          node.getAllTextNodes()[0].select(1, 1)
          const selection = $getSelection()
          if ($isRangeSelection(selection)) {
            $setSpaceBefore(selection, '6px')
          }
        },
        { discrete: true, tag: SKIP_DOM_SELECTION_TAG },
      )
      reopened.getEditorState().read(() => {
        const node = (key === 'code' ? $nodesOfType(CodeNode)[0] : $nodesOfType(ListItemNode)[0])!
        const element = reopened.getElementByKey(node.getKey())!
        expect(element.style.fontSize).toBe('22px')
        expect(element.style.marginTop).toBe('6px')
      })
    } finally {
      stopStyles()
      reopened.setRootElement(null)
      container.remove()
      stopList()
      stopCheckList()
    }
  },
)

it('replaces a custom list glyph with the marker stored in the selected style', async () => {
  const editor = makeEditor()
  const stop = registerList(editor)
  editor.update(
    () => {
      const text = $createTextNode('A list item')
      $getRoot().append($createListNode('bullet').append($createListItemNode().append(text)))
      text.select(0, 0)
      $setCustomListStyle($getSelection(), '★')
    },
    { discrete: true },
  )
  await apply(editor, 'bulletList', {
    ...DEFAULT_TYPOGRAPHY_PROFILE,
    blocks: { bulletList: { listMarkerStyle: 'square' } },
  })
  editor.getEditorState().read(() => expect($getListStyle($nodesOfType(ListNode)[0]!)).toBe('square'))
  stop()
})

it('restyles multiple selected blocks while preserving the range direction and leaves later blocks alone', async () => {
  const editor = makeEditor()
  editor.update(
    () => {
      const first = $createTextNode('First').setFormat('bold')
      const second = $createTextNode('Second').setStyle('color: red;')
      $getRoot().append(
        $createParagraphNode().append(first),
        $createParagraphNode().append(second),
        $createParagraphNode().append($createTextNode('Not selected').setFormat('bold')),
      )
      const selection = $createRangeSelection()
      selection.anchor.set(second.getKey(), 3, 'text')
      selection.focus.set(first.getKey(), 2, 'text')
      $setSelection(selection)
    },
    { discrete: true },
  )
  await apply(editor, 'h2', DEFAULT_TYPOGRAPHY_PROFILE)
  editor.getEditorState().read(() => {
    expect(
      $getRoot()
        .getChildren()
        .slice(0, 2)
        .every((node) => node instanceof HeadingNode && node.getTag() === 'h2'),
    ).toBe(true)
    const selection = $getSelection()
    expect($isRangeSelection(selection) && selection.isBackward()).toBe(true)
    const last = $getRoot().getLastChild()
    expect(last instanceof HeadingNode).toBe(false)
  })
})

it('undoes a complete style choice in one step, including block conversion and direct formatting', async () => {
  const editor = makeEditor()
  const stop = registerHistory(editor, createEmptyHistoryState(), 1000)
  editor.update(
    () => {
      const text = $createTextNode('Original').setFormat('italic')
      $getRoot().append($createParagraphNode().append(text).setStyle('font-size: 30px;'))
      text.select(2, 2)
    },
    { discrete: true },
  )
  const before = editor.getEditorState().toJSON()
  await apply(editor, 'h1', DEFAULT_TYPOGRAPHY_PROFILE)
  editor.dispatchCommand(UNDO_COMMAND, undefined)
  await Promise.resolve()
  editor.update(() => undefined, { discrete: true })
  expect(editor.getEditorState().toJSON()).toEqual(before)
  stop()
})
