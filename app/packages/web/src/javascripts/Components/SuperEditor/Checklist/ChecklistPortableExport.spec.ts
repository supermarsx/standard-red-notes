import { $createListItemNode, $createListNode, ListItemNode, ListNode } from '@lexical/list'
import { $createTextNode, $getRoot, createEditor } from 'lexical'
import { $setChecklistDueAt } from '../Lexical/Nodes/ChecklistItemNode'
import { $projectChecklistDueDatesForPortableExport } from './ChecklistPortableExport'

describe('portable checklist deadline projection', () => {
  it('places parent and child deadlines next to their own labels', () => {
    const editor = createEditor({ nodes: [ListNode, ListItemNode] })
    let text = ''

    editor.update(
      () => {
        const parent = $createListItemNode(false).append($createTextNode('Parent task'))
        const child = $createListItemNode(false).append($createTextNode('Child task'))
        $setChecklistDueAt(parent, '2099-01-02T03:04:00.000Z')
        $setChecklistDueAt(child, '2100-02-03T04:05:00.000Z')
        parent.append($createListNode('check').append(child))
        $getRoot().append($createListNode('check').append(parent))

        expect($projectChecklistDueDatesForPortableExport(Date.parse('2098-01-01T00:00:00.000Z'))).toBe(2)
        text = $getRoot().getTextContent()
      },
      { discrete: true },
    )

    expect(text).toContain('Parent task')
    expect(text).toContain('Child task')
    expect(text.indexOf('Parent task')).toBeLessThan(text.indexOf('2099'))
    expect(text.indexOf('2099')).toBeLessThan(text.indexOf('Child task'))
    expect(text.indexOf('Child task')).toBeLessThan(text.indexOf('2100'))
    expect(text).toContain('[2099-01-02T03:04:00.000Z]')
    expect(text).toContain('[2100-02-03T04:05:00.000Z]')
  })
})
