/**
 * Standard Red Notes — block-level styled element nodes.
 *
 * Base Lexical `ParagraphNode` / `HeadingNode` / `QuoteNode` store an element
 * `__style` string (ElementNode.setStyle/getStyle) but neither RENDER it to the
 * DOM nor SERIALIZE it in exportJSON/importJSON. The Super editor's paragraph
 * layout controls (line spacing, space before/after, left/right/first-line
 * indent, block margins — see Plugins/ToolbarPlugin/blockFormatting.ts) write
 * exactly that element `__style`, so without an override those styles would be
 * lost on reload and never appear in the read-only view.
 *
 * These subclasses close that gap. Each one:
 *   - applies the element `__style` to the DOM in createDOM / updateDOM (so it
 *     renders in BOTH the editable editor and the read-only view, which reuse the
 *     same node set — see BlocksEditorComposer), and in exportDOM (HTML / PDF),
 *   - round-trips `style` through exportJSON / importJSON / updateFromJSON.
 *
 * They are registered as Lexical *node overrides* (replace / with / withKlass) in
 * AllNodes.ts, so every `$createParagraphNode()` etc. — including the ones the
 * base `importJSON` calls when loading an existing note — yields the styled
 * variant. Existing notes (serialized `type: "paragraph"` with no `style`) load
 * unchanged: the base import path routes through `$applyNodeReplacement`, produces
 * a styled node with an empty style, and behaves exactly as before. Only newly
 * styled blocks serialize under the `*-styled` type names with a `style` field.
 *
 * Indentation via the toolbar's Indent / Outdent buttons uses Lexical's built-in
 * `__indent` (INDENT_CONTENT_COMMAND / OUTDENT_CONTENT_COMMAND), which base
 * ElementNode already serializes and renders; it does not depend on these nodes.
 */
import {
  $applyNodeReplacement,
  CreateEditorArgs,
  DOMConversionMap,
  DOMConversionOutput,
  DOMExportOutput,
  EditorConfig,
  ElementNode,
  LexicalEditor,
  ParagraphNode,
  SerializedParagraphNode,
  Spread,
} from 'lexical'
import {
  HeadingNode,
  HeadingTagType,
  QuoteNode,
  SerializedHeadingNode,
  SerializedQuoteNode,
} from '@lexical/rich-text'

/** Serialized shapes: the base shape plus the persisted block `style` string. */
export type SerializedStyledParagraphNode = Spread<{ style?: string }, SerializedParagraphNode>
export type SerializedStyledHeadingNode = Spread<{ style?: string }, SerializedHeadingNode>
export type SerializedStyledQuoteNode = Spread<{ style?: string }, SerializedQuoteNode>

/** Property names in an inline `style` string (lower-cased, in order). */
const stylePropertyNames = (style: string): string[] => {
  const names: string[] = []
  for (const declaration of style.split(';')) {
    const idx = declaration.indexOf(':')
    if (idx === -1) {
      continue
    }
    const property = declaration.slice(0, idx).trim()
    if (property !== '') {
      names.push(property)
    }
  }
  return names
}

/**
 * Apply each declaration of an inline `style` string onto `dom` via
 * `setProperty`, one property at a time. We deliberately DO NOT touch
 * `dom.style.cssText`, because Lexical's reconciler independently sets
 * `text-align` (element format) and `padding-inline-start` (indent) on the same
 * element; a wholesale cssText assignment would clobber them.
 */
const applyBlockStyleToDom = (dom: HTMLElement, style: string): void => {
  for (const declaration of style.split(';')) {
    const idx = declaration.indexOf(':')
    if (idx === -1) {
      continue
    }
    const property = declaration.slice(0, idx).trim()
    const value = declaration.slice(idx + 1).trim()
    if (property !== '' && value !== '') {
      dom.style.setProperty(property, value)
    }
  }
}

/**
 * Reconcile a style change on an existing DOM node: remove the properties that
 * were present before but are gone now, then (re)apply the current ones. Only
 * properties this node manages are touched, so the reconciler's own
 * text-align / padding-inline-start are left intact.
 */
const reconcileBlockStyleDom = (dom: HTMLElement, prevStyle: string, nextStyle: string): void => {
  const nextNames = new Set(stylePropertyNames(nextStyle))
  for (const name of stylePropertyNames(prevStyle)) {
    if (!nextNames.has(name)) {
      dom.style.removeProperty(name)
    }
  }
  applyBlockStyleToDom(dom, nextStyle)
}

const exportDomWithBlockStyle = (output: DOMExportOutput, style: string): DOMExportOutput => {
  if (style !== '' && output.element instanceof HTMLElement) {
    applyBlockStyleToDom(output.element, style)
  }
  return output
}

/**
 * Block-layout CSS properties we round-trip through HTML import (paste). We only
 * capture these — not text-align (handled as element format) or
 * padding-inline-start (handled as `__indent`) — so importing never fights the
 * base conversion's own format / indent handling.
 */
const BLOCK_LAYOUT_PROPERTIES = [
  'line-height',
  'margin-top',
  'margin-bottom',
  'margin-left',
  'margin-right',
  'padding-left',
  'padding-right',
  'text-indent',
]

const captureBlockStyleFromElement = (element: HTMLElement): string => {
  const parts: string[] = []
  for (const property of BLOCK_LAYOUT_PROPERTIES) {
    const value = element.style.getPropertyValue(property).trim()
    if (value !== '') {
      parts.push(`${property}: ${value}`)
    }
  }
  return parts.join('; ')
}

/**
 * Wrap a base DOMConversionMap so each produced block ElementNode also inherits
 * the source element's block-layout inline styles when pasting HTML.
 */
const withBlockStyleImport = (base: DOMConversionMap | null): DOMConversionMap | null => {
  if (base === null) {
    return null
  }
  const wrapped: DOMConversionMap = {}
  for (const tag of Object.keys(base)) {
    const matcher = base[tag]
    wrapped[tag] = (node: HTMLElement) => {
      const result = matcher(node)
      if (result === null) {
        return null
      }
      const originalConversion = result.conversion
      return {
        ...result,
        conversion: (element: HTMLElement): DOMConversionOutput | null => {
          const output = originalConversion(element)
          if (output !== null && output.node !== null && !Array.isArray(output.node) && output.node instanceof ElementNode) {
            const style = captureBlockStyleFromElement(element)
            if (style !== '') {
              output.node.setStyle(style)
            }
          }
          return output
        },
      }
    }
  }
  return wrapped
}

export class StyledParagraphNode extends ParagraphNode {
  static getType(): string {
    return 'paragraph-styled'
  }

  static clone(node: StyledParagraphNode): StyledParagraphNode {
    return new StyledParagraphNode(node.__key)
  }

  createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config)
    applyBlockStyleToDom(dom, this.__style)
    return dom
  }

  updateDOM(prevNode: StyledParagraphNode, dom: HTMLElement, config: EditorConfig): boolean {
    const needsReplace = super.updateDOM(prevNode, dom, config)
    if (!needsReplace && prevNode.__style !== this.__style) {
      reconcileBlockStyleDom(dom, prevNode.__style, this.__style)
    }
    return needsReplace
  }

  static importDOM(): DOMConversionMap | null {
    return withBlockStyleImport(ParagraphNode.importDOM())
  }

  exportDOM(editor: LexicalEditor): DOMExportOutput {
    return exportDomWithBlockStyle(super.exportDOM(editor), this.__style)
  }

  exportJSON(): SerializedStyledParagraphNode {
    return { ...super.exportJSON(), style: this.getStyle() }
  }

  updateFromJSON(serializedNode: SerializedStyledParagraphNode): this {
    return super.updateFromJSON(serializedNode).setStyle(serializedNode.style ?? '') as this
  }

  static importJSON(serializedNode: SerializedStyledParagraphNode): StyledParagraphNode {
    return $createStyledParagraphNode().updateFromJSON(serializedNode)
  }
}

export class StyledHeadingNode extends HeadingNode {
  static getType(): string {
    return 'heading-styled'
  }

  static clone(node: StyledHeadingNode): StyledHeadingNode {
    return new StyledHeadingNode(node.__tag, node.__key)
  }

  createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config)
    applyBlockStyleToDom(dom, this.__style)
    return dom
  }

  updateDOM(prevNode: StyledHeadingNode, dom: HTMLElement, config: EditorConfig): boolean {
    // Base returns true when the heading tag changed (→ DOM recreated, style
    // re-applied by createDOM). Otherwise apply the style diff in place. The base
    // signature is `updateDOM(prevNode: this, ...)`, so cast through `this`.
    const needsReplace = super.updateDOM(prevNode as this, dom, config)
    if (!needsReplace && prevNode.__style !== this.__style) {
      reconcileBlockStyleDom(dom, prevNode.__style, this.__style)
    }
    return needsReplace
  }

  static importDOM(): DOMConversionMap | null {
    return withBlockStyleImport(HeadingNode.importDOM())
  }

  exportDOM(editor: LexicalEditor): DOMExportOutput {
    return exportDomWithBlockStyle(super.exportDOM(editor), this.__style)
  }

  exportJSON(): SerializedStyledHeadingNode {
    return { ...super.exportJSON(), style: this.getStyle() }
  }

  updateFromJSON(serializedNode: SerializedStyledHeadingNode): this {
    return super.updateFromJSON(serializedNode).setStyle(serializedNode.style ?? '') as this
  }

  static importJSON(serializedNode: SerializedStyledHeadingNode): StyledHeadingNode {
    return $createStyledHeadingNode(serializedNode.tag).updateFromJSON(serializedNode)
  }
}

export class StyledQuoteNode extends QuoteNode {
  static getType(): string {
    return 'quote-styled'
  }

  static clone(node: StyledQuoteNode): StyledQuoteNode {
    return new StyledQuoteNode(node.__key)
  }

  createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config)
    applyBlockStyleToDom(dom, this.__style)
    return dom
  }

  updateDOM(prevNode: StyledQuoteNode, dom: HTMLElement): boolean {
    if (prevNode.__style !== this.__style) {
      reconcileBlockStyleDom(dom, prevNode.__style, this.__style)
    }
    return false
  }

  static importDOM(): DOMConversionMap | null {
    return withBlockStyleImport(QuoteNode.importDOM())
  }

  exportDOM(editor: LexicalEditor): DOMExportOutput {
    return exportDomWithBlockStyle(super.exportDOM(editor), this.__style)
  }

  exportJSON(): SerializedStyledQuoteNode {
    return { ...super.exportJSON(), style: this.getStyle() }
  }

  updateFromJSON(serializedNode: SerializedStyledQuoteNode): this {
    return super.updateFromJSON(serializedNode).setStyle(serializedNode.style ?? '') as this
  }

  static importJSON(serializedNode: SerializedStyledQuoteNode): StyledQuoteNode {
    return $createStyledQuoteNode().updateFromJSON(serializedNode)
  }
}

export function $createStyledParagraphNode(): StyledParagraphNode {
  return $applyNodeReplacement(new StyledParagraphNode())
}

export function $createStyledHeadingNode(tag: HeadingTagType): StyledHeadingNode {
  return $applyNodeReplacement(new StyledHeadingNode(tag))
}

export function $createStyledQuoteNode(): StyledQuoteNode {
  return $applyNodeReplacement(new StyledQuoteNode())
}

/**
 * Node-override registrations to add to the editor `nodes` array. Each styled
 * class is registered BOTH as a standalone node (so its own `*-styled` type
 * deserializes and instances can be constructed) AND as a replacement of its
 * base (so every `$createParagraphNode()` etc. — including the base `importJSON`
 * used when loading an existing note — yields the styled variant). Base
 * ParagraphNode is always core-registered; base HeadingNode / QuoteNode are
 * registered in AllNodes.
 */
export const STYLED_BLOCK_NODE_OVERRIDES: NonNullable<CreateEditorArgs['nodes']> = [
  StyledParagraphNode,
  StyledHeadingNode,
  StyledQuoteNode,
  {
    replace: ParagraphNode,
    with: (_node: ParagraphNode): StyledParagraphNode => $createStyledParagraphNode(),
    withKlass: StyledParagraphNode,
  },
  {
    replace: HeadingNode,
    with: (node: HeadingNode): StyledHeadingNode => $createStyledHeadingNode(node.getTag()),
    withKlass: StyledHeadingNode,
  },
  {
    replace: QuoteNode,
    with: (_node: QuoteNode): StyledQuoteNode => $createStyledQuoteNode(),
    withKlass: StyledQuoteNode,
  },
]
