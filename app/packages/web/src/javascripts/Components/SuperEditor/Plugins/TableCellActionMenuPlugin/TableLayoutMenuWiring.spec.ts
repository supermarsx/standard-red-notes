/**
 * VANISH GUARD, part two: is the Layout group actually WIRED IN?
 *
 * `TableLayoutMenuSection.spec.tsx` proves the controls render and work when
 * mounted. That is not the same as proving the table action menu mounts them —
 * a group that typechecks, passes its tests and is rendered by nobody is the
 * documented failure mode in this editor (see
 * ToolbarPlugin.checklistGroup.spec.tsx). This reads the menu source, the way
 * WidgetLayoutContract.spec.ts does, because the alternative — mounting the real
 * floating menu — needs a live DOM selection inside a contenteditable that jsdom
 * cannot produce.
 *
 * It lives in its own file so it can land with the menu edit it guards, rather
 * than racing a peer who is adding a sibling group to the same file.
 */
import fs from 'node:fs'
import path from 'node:path'

const menuSource = fs.readFileSync(path.join(__dirname, 'index.tsx'), 'utf8')

describe('the Layout group is wired into the table action menu', () => {
  it('is imported and rendered by the menu, not merely defined', () => {
    expect(menuSource).toContain("import { TableLayoutMenuSection } from './TableLayoutMenuSection'")
    expect(menuSource).toContain('<TableLayoutMenuSection editor={editor} tableCellNode={tableCellNode} />')
  })

  it('leaves the selection-scoped container that other widgets mirror untouched', () => {
    // The positioning/portal shell is the pattern the mermaid controls copy; the
    // layout group is added to the menu BODY only.
    expect(menuSource).toContain('createPortal(')
    expect(menuSource).toContain('const setMenuButtonPosition = useCallback(')
  })
})

describe('the action menu nests only its rarer actions', () => {
  const submenuStart = menuSource.indexOf('<TableActionSubmenu')
  const submenuEnd = menuSource.indexOf('</TableActionSubmenu>')

  it('uses the in-place submenu', () => {
    expect(menuSource).toContain("import { TableActionSubmenu } from './TableActionSubmenu'")
    expect(submenuStart).toBeGreaterThan(-1)
    expect(submenuEnd).toBeGreaterThan(submenuStart)
  })

  it('keeps every frequently used row and column action at the top level', () => {
    // A submenu costs a hover/click step on every use, so these must NOT be nested.
    for (const action of [
      'insertTableRowAtSelection(false)',
      'insertTableRowAtSelection(true)',
      'insertTableColumnAtSelection(false)',
      'insertTableColumnAtSelection(true)',
      'deleteTableRowAtSelection',
      'deleteTableColumnAtSelection',
    ]) {
      const at = menuSource.indexOf(action)
      expect(at).toBeGreaterThan(-1)
      expect(at).toBeLessThan(submenuStart)
    }
  })

  it('nests the header toggles and the destructive whole-table delete', () => {
    for (const action of ['toggleTableRowIsHeader(', 'toggleTableColumnIsHeader(', 'deleteTableAtSelection}']) {
      const at = menuSource.indexOf(action, submenuStart)
      expect(at).toBeGreaterThan(submenuStart)
      expect(at).toBeLessThan(submenuEnd)
    }
  })
})
