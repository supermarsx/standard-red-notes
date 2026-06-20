/**
 * @jest-environment jsdom
 *
 * Round-trips the serialization of the custom Lexical decorator block nodes:
 * KanbanNode, CalendarNode, DataTableNode, CalloutNode and EmbedNode.
 *
 * For each node we assert:
 *   - data is preserved exactly across exportJSON -> importJSON -> exportJSON
 *   - the `type` and `version` fields are stable
 * and across all nodes we assert getType() values are unique.
 *
 * NOTE ON THE EDITOR: these nodes extend Lexical's DecoratorNode, whose base
 * constructor calls $setNodeKey(), which requires an *active editor context* in
 * Lexical 0.45 (it throws "Unable to find an active editor" otherwise). So even
 * though importJSON/exportJSON do not themselves touch editor state, simply
 * CONSTRUCTING a node (which the $createXNode factories and importJSON both do)
 * must happen inside editor.update() (creating a node assigns it a key, which is
 * a write, so a read-only editor.read() context is rejected with "Cannot use
 * method in read-only mode"). We therefore use a *headless* editor (no React, no
 * DOM mount) and run all node work inside editor.update(). This is the lightest
 * possible editor context and avoids mounting a real LexicalEditor/React tree.
 */

import { createHeadlessEditor } from '@lexical/headless'

import { $createKanbanNode, KanbanNode, KanbanData, DEFAULT_BOARD_TITLE } from './KanbanNode'
import { $createCalendarNode, CalendarNode, CalendarData } from './CalendarNode'
import { $createDataTableNode, DataTableNode, DataTableData } from './DataTableNode'
import { $createCalloutNode, CalloutNode, CalloutData } from './CalloutNode'
import { $createEmbedNode, EmbedNode, EmbedData } from './EmbedNode'

const editor = createHeadlessEditor({
  namespace: 'EditorBlockSerializationTest',
  nodes: [KanbanNode, CalendarNode, DataTableNode, CalloutNode, EmbedNode],
  onError: (error) => {
    throw error
  },
})

/**
 * Run a function inside the headless editor's update (writable) context and
 * return its value. Construction of a node assigns it a key, which is a write,
 * so this must be an update() context rather than a read() context. We discard
 * the editor state afterwards (these nodes are never attached to the root).
 */
function inEditor<T>(fn: () => T): T {
  let result: T
  editor.update(
    () => {
      result = fn()
    },
    { discrete: true },
  )
  return result!
}

type AnySerialized = { type: string; version: number; data: unknown }

/**
 * Generic round-trip: export the node, re-import the serialized form into a new
 * node, then export that. Both serialized snapshots are returned so the caller
 * can deep-compare them. Runs inside the headless editor update context.
 */
function roundTrip<S extends AnySerialized>(
  createNode: () => { exportJSON(): S },
  importJSON: (serialized: S) => { exportJSON(): S },
): { first: S; second: S } {
  return inEditor(() => {
    const first = createNode().exportJSON()
    const second = importJSON(first).exportJSON()
    return { first, second }
  })
}

describe('Editor block node serialization', () => {
  describe('KanbanNode', () => {
    const custom: KanbanData = {
      title: 'Sprint 42 / Q3 roadmap — fully renamed',
      columns: [
        { id: 'col-1', title: 'Backlog', cards: [{ id: 'card-1', text: 'Write tests' }] },
        { id: 'col-2', title: 'Done', cards: [] },
      ],
    }

    it.each<['default' | 'custom', () => KanbanNode]>([
      ['default', () => $createKanbanNode()],
      ['custom', () => $createKanbanNode(custom)],
    ])('round-trips %s data without loss', (_label, create) => {
      const { first, second } = roundTrip(create, KanbanNode.importJSON)
      expect(second.data).toEqual(first.data)
      expect(second).toEqual(first)
    })

    it('keeps type and version stable', () => {
      const { first, second } = roundTrip(() => $createKanbanNode(custom), KanbanNode.importJSON)
      expect(first.type).toBe('kanban')
      expect(first.type).toBe(KanbanNode.getType())
      expect(first.version).toBe(1)
      expect(second.type).toBe(first.type)
      expect(second.version).toBe(first.version)
    })

    it('preserves nested column and card fields exactly', () => {
      const { second } = roundTrip(() => $createKanbanNode(custom), KanbanNode.importJSON)
      expect(second.data).toEqual(custom)
    })

    it('round-trips an edited board title without loss', () => {
      const { first, second } = roundTrip(() => $createKanbanNode(custom), KanbanNode.importJSON)
      expect((first.data as KanbanData).title).toBe('Sprint 42 / Q3 roadmap — fully renamed')
      expect((second.data as KanbanData).title).toBe('Sprint 42 / Q3 roadmap — fully renamed')
    })

    it('uses the default board title for newly created boards', () => {
      const { first } = roundTrip(() => $createKanbanNode(), KanbanNode.importJSON)
      expect((first.data as KanbanData).title).toBe(DEFAULT_BOARD_TITLE)
    })

    it('backfills a missing title when importing pre-title (legacy) notes', () => {
      const legacy = {
        type: 'kanban',
        version: 1,
        // legacy notes were serialized before the title field existed
        data: { columns: [{ id: 'c1', title: 'To do', cards: [] }] } as unknown as KanbanData,
      } as const
      const imported = inEditor(() => KanbanNode.importJSON(legacy as never).exportJSON())
      expect((imported.data as KanbanData).title).toBe(DEFAULT_BOARD_TITLE)
      expect((imported.data as KanbanData).columns).toEqual([{ id: 'c1', title: 'To do', cards: [] }])
    })

    it('round-trips per-column colors without loss', () => {
      const colored: KanbanData = {
        title: 'Colored board',
        columns: [
          { id: 'col-1', title: 'Red', color: '#ef4444', cards: [{ id: 'card-1', text: 'Urgent' }] },
          { id: 'col-2', title: 'No color', cards: [] },
        ],
      }
      const { first, second } = roundTrip(() => $createKanbanNode(colored), KanbanNode.importJSON)
      expect((first.data as KanbanData).columns[0].color).toBe('#ef4444')
      expect((second.data as KanbanData).columns[0].color).toBe('#ef4444')
      // A column with no color stays colorless across the round-trip.
      expect((second.data as KanbanData).columns[1].color).toBeUndefined()
      expect(second.data).toEqual(colored)
    })

    it('imports a legacy board without colors and leaves columns colorless', () => {
      const legacy = {
        type: 'kanban',
        version: 1,
        // boards serialized before per-column colors existed have no `color`
        data: {
          title: 'Legacy',
          columns: [{ id: 'c1', title: 'To do', cards: [] }],
        } as unknown as KanbanData,
      } as const
      const imported = inEditor(() => KanbanNode.importJSON(legacy as never).exportJSON())
      const col = (imported.data as KanbanData).columns[0]
      expect(col.color).toBeUndefined()
      // No stray `color` key is introduced for legacy columns.
      expect(col).toEqual({ id: 'c1', title: 'To do', cards: [] })
    })

    it('drops an invalid column color on import', () => {
      const bad = {
        type: 'kanban',
        version: 1,
        data: {
          title: 'Bad color',
          columns: [{ id: 'c1', title: 'To do', color: 'not-a-color', cards: [] }],
        } as unknown as KanbanData,
      } as const
      const imported = inEditor(() => KanbanNode.importJSON(bad as never).exportJSON())
      const col = (imported.data as KanbanData).columns[0]
      expect(col.color).toBeUndefined()
      expect(col).toEqual({ id: 'c1', title: 'To do', cards: [] })
    })
  })

  describe('CalendarNode', () => {
    const custom: CalendarData = {
      events: {
        '2026-06-19': ['Ship release', 'Retro'],
        '2026-07-01': ['Quarter kickoff'],
      },
    }

    it.each<['default' | 'custom', () => CalendarNode]>([
      ['default', () => $createCalendarNode()],
      ['custom', () => $createCalendarNode(custom)],
    ])('round-trips %s data without loss', (_label, create) => {
      const { first, second } = roundTrip(create, CalendarNode.importJSON)
      expect(second.data).toEqual(first.data)
      expect(second).toEqual(first)
    })

    it('keeps type and version stable', () => {
      const { first, second } = roundTrip(() => $createCalendarNode(custom), CalendarNode.importJSON)
      expect(first.type).toBe('calendar')
      expect(first.type).toBe(CalendarNode.getType())
      expect(first.version).toBe(1)
      expect(second.type).toBe(first.type)
      expect(second.version).toBe(first.version)
    })

    it('preserves the events record exactly', () => {
      const { second } = roundTrip(() => $createCalendarNode(custom), CalendarNode.importJSON)
      expect(second.data).toEqual(custom)
    })
  })

  describe('DataTableNode', () => {
    const custom: DataTableData = {
      columns: ['Task', 'Owner'],
      rows: [
        ['Build', 'Ada'],
        ['Ship', 'Linus'],
      ],
    }

    it.each<['default' | 'custom', () => DataTableNode]>([
      ['default', () => $createDataTableNode()],
      ['custom', () => $createDataTableNode(custom)],
    ])('round-trips %s data without loss', (_label, create) => {
      const { first, second } = roundTrip(create, DataTableNode.importJSON)
      expect(second.data).toEqual(first.data)
      expect(second).toEqual(first)
    })

    it('keeps type and version stable', () => {
      const { first, second } = roundTrip(() => $createDataTableNode(custom), DataTableNode.importJSON)
      expect(first.type).toBe('datatable')
      expect(first.type).toBe(DataTableNode.getType())
      expect(first.version).toBe(1)
      expect(second.type).toBe(first.type)
      expect(second.version).toBe(first.version)
    })

    it('preserves columns and rows exactly', () => {
      const { second } = roundTrip(() => $createDataTableNode(custom), DataTableNode.importJSON)
      expect(second.data).toEqual(custom)
    })
  })

  describe('CalloutNode', () => {
    const custom: CalloutData = { variant: 'warning', text: 'Heads up\nsecond line' }

    it.each<['default' | 'custom', () => CalloutNode]>([
      ['default', () => $createCalloutNode()],
      ['custom', () => $createCalloutNode(custom)],
    ])('round-trips %s data without loss', (_label, create) => {
      const { first, second } = roundTrip(create, CalloutNode.importJSON)
      expect(second.data).toEqual(first.data)
      expect(second).toEqual(first)
    })

    it('keeps type and version stable', () => {
      const { first, second } = roundTrip(() => $createCalloutNode(custom), CalloutNode.importJSON)
      expect(first.type).toBe('callout')
      expect(first.type).toBe(CalloutNode.getType())
      expect(first.version).toBe(1)
      expect(second.type).toBe(first.type)
      expect(second.version).toBe(first.version)
    })

    it('preserves variant and text exactly', () => {
      const { second } = roundTrip(() => $createCalloutNode(custom), CalloutNode.importJSON)
      expect(second.data).toEqual(custom)
    })
  })

  describe('EmbedNode', () => {
    const custom: EmbedData = { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }

    it.each<['default' | 'custom', () => EmbedNode]>([
      ['default', () => $createEmbedNode()],
      ['custom', () => $createEmbedNode(custom)],
    ])('round-trips %s data without loss', (_label, create) => {
      const { first, second } = roundTrip(create, EmbedNode.importJSON)
      expect(second.data).toEqual(first.data)
      expect(second).toEqual(first)
    })

    it('keeps type and version stable', () => {
      const { first, second } = roundTrip(() => $createEmbedNode(custom), EmbedNode.importJSON)
      expect(first.type).toBe('embed')
      expect(first.type).toBe(EmbedNode.getType())
      expect(first.version).toBe(1)
      expect(second.type).toBe(first.type)
      expect(second.version).toBe(first.version)
    })

    it('preserves the url exactly', () => {
      const { second } = roundTrip(() => $createEmbedNode(custom), EmbedNode.importJSON)
      expect(second.data).toEqual(custom)
    })
  })

  it('exposes a unique getType() across all five block nodes', () => {
    const types = [
      KanbanNode.getType(),
      CalendarNode.getType(),
      DataTableNode.getType(),
      CalloutNode.getType(),
      EmbedNode.getType(),
    ]
    expect(new Set(types).size).toBe(types.length)
    expect(types).toEqual(['kanban', 'calendar', 'datatable', 'callout', 'embed'])
  })
})
