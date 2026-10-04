/**
 * @jest-environment jsdom
 *
 * The Mermaid block's glyph on the two surfaces that take it from the shared
 * catalog: the Insert tab's "Diagrams & charts" section and the slash picker.
 *
 * Both read `MermaidBlock.iconName` — the catalog copies it in `fromBlock`, and
 * the slash picker maps catalog entries into `BlockPickerOption` — so this asserts
 * the PROPAGATION (one edit reaches both) rather than restating the constant, and
 * then asserts each surface draws a real <svg>.
 *
 * The mapping-miss trap is the reason the render assertions exist: `Icon` renders
 * its `type` as literal text inside a <label> when the name is in neither icon
 * map, `VectorIconNameOrEmoji` admits any string so tsc is blind, and these names
 * arrive as dynamic props so `IconNameCoverage.spec.ts` does not sweep them.
 */
import { act } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { createHeadlessEditor } from '@lexical/headless'
import { LexicalIconNameToSvgMapping } from '@/Components/Icon/LexicalIcons'
import { IconNameToSvgMapping } from '@/Components/Icon/IconNameToSvgMapping'
import { GetMermaidBlockOption, MermaidBlock } from './Mermaid'
import { getFullBlockCatalog } from './blockCatalog'
import { BlockPickerMenuItem } from '../BlockPickerPlugin/BlockPickerMenuItem'
import { BlockEditorNodes } from '../../Lexical/Nodes/AllNodes'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const editor = createHeadlessEditor({
  namespace: 'MermaidIconTest',
  nodes: BlockEditorNodes,
  onError: (error) => {
    throw error
  },
})

let container: HTMLElement
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

const catalogEntry = () => {
  const entry = getFullBlockCatalog(editor).find((candidate) => candidate.name === MermaidBlock.name)
  if (!entry) {
    // An empty find would make every assertion below vacuous.
    throw new Error('the Mermaid block is not in the shared catalog at all')
  }
  return entry
}

describe('the icon name reaches both catalog-driven surfaces from one place', () => {
  it('is a name one of the icon maps actually resolves', () => {
    const name = MermaidBlock.iconName
    const resolved =
      IconNameToSvgMapping[name as unknown as keyof typeof IconNameToSvgMapping] ??
      LexicalIconNameToSvgMapping[name as keyof typeof LexicalIconNameToSvgMapping]
    expect(resolved).toBeDefined()
  })

  it('is the diagram glyph, not the generic code one', () => {
    expect(MermaidBlock.iconName).toBe('diagram')
    expect(LexicalIconNameToSvgMapping.diagram).toBeDefined()
  })

  it('propagates into the shared catalog entry the Insert tab renders', () => {
    expect(catalogEntry().iconName).toBe(MermaidBlock.iconName)
    expect(catalogEntry().category).toBe('Diagrams & charts')
  })

  it('propagates into the block-picker option the slash picker renders', () => {
    expect(GetMermaidBlockOption(editor).iconName).toBe(MermaidBlock.iconName)
  })
})

describe('the slash picker draws the glyph, never the icon name as text', () => {
  const renderPickerItem = () => {
    const option = GetMermaidBlockOption(editor)
    act(() => {
      root.render(
        <BlockPickerMenuItem
          index={0}
          isSelected={false}
          onClick={() => undefined}
          onMouseEnter={() => undefined}
          option={option}
        />,
      )
    })
    return container.querySelector('[role="option"]') as HTMLElement
  }

  it('renders an svg and no label fallback', () => {
    const item = renderPickerItem()
    expect(item).not.toBeNull()
    expect(item.querySelector('svg')).not.toBeNull()
    expect(item.querySelector('label')).toBeNull()
  })

  it('shows the block name and not the icon name', () => {
    const item = renderPickerItem()
    // No i18n provider is mounted here, so the title renders as its translation
    // KEY. Asserted as rendered rather than as prose — and it still carries the
    // block's identity, which is what makes the next assertion meaningful.
    expect(item.textContent).toContain('MermaidDiagram')
    // The failure mode: `<label>diagram</label>` instead of the glyph. Matched
    // case-sensitively on the icon name itself, which the visible title does not
    // contain (the key capitalises it).
    expect(item.textContent).not.toContain('diagram')
  })

  it('draws the glyph at the picker’s own size, not the toolbar’s', () => {
    const svg = renderPickerItem().querySelector('svg') as SVGElement
    // 20px (h-5 w-5) — larger than the 14px toolbar box the glyph was drawn for,
    // so if it is legible there it is legible here.
    expect(svg.getAttribute('class') ?? '').toContain('h-5')
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24')
  })
})
