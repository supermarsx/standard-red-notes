/**
 * @jest-environment jsdom
 *
 * Proves that block-level element styles (line spacing, paragraph spacing,
 * indentation) applied by the Super editor's paragraph-layout controls actually
 * PERSIST and RENDER, via the StyledParagraph/Heading/Quote node overrides.
 *
 * Coverage:
 *   1. A styled paragraph survives a FULL editorState JSON round-trip
 *      (toJSON -> stringify -> parseEditorState) with its styles intact — the
 *      exact save/reload path a note takes. Base Lexical ParagraphNode drops
 *      element `__style` on export, so this is the regression this feature fixes.
 *   2. createDOM applies the style to the DOM (so it renders identically in the
 *      editable editor AND the read-only view, which share this node set).
 *   3. EXISTING notes still load: a legacy `type: "paragraph"` node with no
 *      `style` deserializes (via the replace/with override path) to a styled
 *      node with an empty style and no inline style attribute — behaves exactly
 *      as before.
 *   4. Headings and quotes round-trip their styles too.
 *
 * Node construction assigns a key (a write needing an active editor in Lexical
 * 0.45), so all node work runs inside editor.update()/read(). We register the
 * nodes exactly as the app does (base Heading/Quote + the override configs).
 */
import { createHeadlessEditor } from '@lexical/headless'
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $selectAll,
  EditorConfig,
} from 'lexical'
import { HeadingNode, QuoteNode } from '@lexical/rich-text'

import {
  $createStyledHeadingNode,
  $createStyledQuoteNode,
  STYLED_BLOCK_NODE_OVERRIDES,
  StyledHeadingNode,
  StyledParagraphNode,
  StyledQuoteNode,
} from './StyledBlockNodes'
import {
  $setIndent,
  $setLineHeight,
  $setSpaceAfter,
  $setSpaceBefore,
  parseStyleString,
} from '../../Plugins/ToolbarPlugin/blockFormatting'

const makeEditor = () =>
  createHeadlessEditor({
    namespace: 'StyledBlockNodesTest',
    nodes: [HeadingNode, QuoteNode, ...STYLED_BLOCK_NODE_OVERRIDES],
    onError: (error) => {
      throw error
    },
  })

function inEditor<T>(editor: ReturnType<typeof makeEditor>, fn: () => T): T {
  let result: T
  editor.update(
    () => {
      result = fn()
    },
    { discrete: true },
  )
  return result!
}

/** Serialize the whole editor state to a JSON string, exactly like a note save. */
const saveToJSON = (editor: ReturnType<typeof makeEditor>): string =>
  JSON.stringify(editor.getEditorState().toJSON())

describe('Styled block node overrides', () => {
  it('replaces base paragraph creation with the styled variant', () => {
    const editor = makeEditor()
    const isStyled = inEditor(editor, () => $createParagraphNode() instanceof StyledParagraphNode)
    expect(isStyled).toBe(true)
  })

  describe('paragraph line-spacing + paragraph-spacing persistence', () => {
    it('round-trips element styles through a full editorState JSON save/reload', () => {
      const editor = makeEditor()

      // Build a paragraph, select it, and apply the real toolbar helpers.
      inEditor(editor, () => {
        const root = $getRoot()
        root.clear()
        root.append($createParagraphNode().append($createTextNode('hello world')))
        $selectAll()
        const selection = $getSelection()
        if ($isRangeSelection(selection)) {
          $setLineHeight(selection, '1.75')
          $setSpaceBefore(selection, '8px')
          $setSpaceAfter(selection, '12px')
          $setIndent(selection, '40px')
        }
      })

      // Save (stringify) and reload (parse) — the note save/open path.
      const saved = saveToJSON(editor)
      expect(saved).toContain('paragraph-styled')
      expect(saved).toContain('line-height: 1.75')

      const restored = editor.parseEditorState(saved)
      const style = restored.read(() => ($getRoot().getFirstChild() as StyledParagraphNode).getStyle())
      const map = parseStyleString(style)
      expect(map.get('line-height')).toBe('1.75')
      expect(map.get('margin-top')).toBe('8px')
      expect(map.get('margin-bottom')).toBe('12px')
      expect(map.get('padding-left')).toBe('40px')
    })

    it('renders the style onto the DOM via createDOM (editor + read-only views)', () => {
      const editor = makeEditor()
      inEditor(editor, () => {
        const root = $getRoot()
        root.clear()
        root.append($createParagraphNode().append($createTextNode('x')))
        $selectAll()
        const selection = $getSelection()
        if ($isRangeSelection(selection)) {
          $setLineHeight(selection, '2')
          $setSpaceAfter(selection, '16px')
        }
      })

      const config = (editor as unknown as { _config: EditorConfig })._config
      const { lineHeight, marginBottom, tag } = editor.getEditorState().read(() => {
        const paragraph = $getRoot().getFirstChild() as StyledParagraphNode
        const dom = paragraph.createDOM(config) as HTMLElement
        return { lineHeight: dom.style.lineHeight, marginBottom: dom.style.marginBottom, tag: dom.tagName }
      })
      expect(tag).toBe('P')
      expect(lineHeight).toBe('2')
      expect(marginBottom).toBe('16px')
    })
  })

  describe('backward compatibility with existing (unstyled) notes', () => {
    it('loads a legacy base "paragraph" node as a styled node with no style', () => {
      const editor = makeEditor()
      const legacy = {
        root: {
          children: [
            {
              children: [{ detail: 0, format: 0, mode: 'normal', style: '', text: 'legacy', type: 'text', version: 1 }],
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
      const parsed = editor.parseEditorState(JSON.stringify(legacy))
      const { isStyled, style, text } = parsed.read(() => {
        const paragraph = $getRoot().getFirstChild() as StyledParagraphNode
        return {
          isStyled: paragraph instanceof StyledParagraphNode,
          style: paragraph.getStyle(),
          text: paragraph.getTextContent(),
        }
      })
      expect(isStyled).toBe(true)
      expect(style).toBe('')
      expect(text).toBe('legacy')
    })

    it('createDOM emits no inline style for an unstyled paragraph', () => {
      const editor = makeEditor()
      inEditor(editor, () => {
        $getRoot().clear()
        $getRoot().append($createParagraphNode().append($createTextNode('plain')))
      })
      const config = (editor as unknown as { _config: EditorConfig })._config
      const styleAttr = editor.getEditorState().read(() => {
        const dom = ($getRoot().getFirstChild() as StyledParagraphNode).createDOM(config) as HTMLElement
        return dom.getAttribute('style')
      })
      expect(styleAttr).toBeNull()
    })
  })

  describe('heading + quote persistence', () => {
    it('round-trips a styled heading (keeping its tag) and a styled quote', () => {
      const editor = makeEditor()
      inEditor(editor, () => {
        const root = $getRoot()
        root.clear()
        const heading = $createStyledHeadingNode('h2').append($createTextNode('Title'))
        heading.setStyle('line-height: 1.5; margin-bottom: 24px')
        const quote = $createStyledQuoteNode().append($createTextNode('Quote'))
        quote.setStyle('margin-top: 8px')
        root.append(heading, quote)
      })

      const saved = saveToJSON(editor)
      expect(saved).toContain('heading-styled')
      expect(saved).toContain('quote-styled')

      const restored = editor.parseEditorState(saved)
      const result = restored.read(() => {
        const heading = $getRoot().getChildAtIndex(0) as StyledHeadingNode
        const quote = $getRoot().getChildAtIndex(1) as StyledQuoteNode
        return {
          isHeading: heading instanceof StyledHeadingNode,
          tag: heading.getTag(),
          headingStyle: heading.getStyle(),
          isQuote: quote instanceof StyledQuoteNode,
          quoteStyle: quote.getStyle(),
        }
      })
      expect(result.isHeading).toBe(true)
      expect(result.tag).toBe('h2')
      expect(parseStyleString(result.headingStyle).get('margin-bottom')).toBe('24px')
      expect(result.isQuote).toBe(true)
      expect(parseStyleString(result.quoteStyle).get('margin-top')).toBe('8px')
    })
  })

  it('exposes unique, stable getType() names', () => {
    expect(StyledParagraphNode.getType()).toBe('paragraph-styled')
    expect(StyledHeadingNode.getType()).toBe('heading-styled')
    expect(StyledQuoteNode.getType()).toBe('quote-styled')
  })
})
