import * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  $getNodeByKey,
  CLICK_COMMAND,
  COMMAND_PRIORITY_LOW,
  DecoratorNode,
  DOMExportOutput,
  EditorConfig,
  LexicalEditor,
  LexicalNode,
  NodeKey,
  SerializedLexicalNode,
  Spread,
} from 'lexical'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { useLexicalNodeSelection } from '@lexical/react/useLexicalNodeSelection'
import Icon from '@/Components/Icon/Icon'
import {
  analyzeMermaidSource,
  appendGraphEdge,
  appendGraphNode,
  buildFlowchartSource,
  createEmptyGraphModel,
  danglingExtras,
  DEFAULT_MERMAID_EDGE_KIND,
  DEFAULT_MERMAID_NODE_SHAPE,
  MERMAID_DIAGRAM_TYPE_LABELS,
  MERMAID_EDGE_KIND_LABELS,
  MERMAID_EDGE_KINDS,
  MERMAID_GRAPH_DIRECTIONS,
  MERMAID_NODE_SHAPE_LABELS,
  MERMAID_NODE_SHAPES,
  MERMAID_TEMPLATES,
  MermaidEdgeKind,
  MermaidGraphDirection,
  MermaidGraphEdge,
  MermaidGraphModel,
  MermaidGraphNode,
  MermaidNodeShape,
  removeGraphNode,
  renameGraphNode,
} from './MermaidGraphBuilder'
import MermaidSvgViewport from './MermaidSvgViewport'
import { MermaidResizeHandle } from './MermaidBlockControls'
import { MermaidWidthUnit, normalizeMermaidHeight, normalizeMermaidWidth, parseMermaidWidth } from './MermaidWidth'
import {
  DEFAULT_MERMAID_THEME_MODE,
  DEFAULT_MERMAID_VIEW_MODE,
  mermaidAlignmentStyle,
  type MermaidAppTheme,
  MermaidMaxHeight,
  type MermaidRenderTheme,
  MermaidSettings,
  MermaidThemeMode,
  MermaidViewMode,
  migrateMermaidThemeMode,
  normalizeMermaidViewMode,
  resolveMermaidMaxHeightPx,
  resolveMermaidRenderTheme,
  resolveMermaidSettings,
  resolveMermaidSurfaceColor,
} from './MermaidSettings'
import { useMermaidAppTheme } from './MermaidAppTheme'

const DEFAULT_MERMAID = 'graph TD\n  A[Start] --> B{Decision}\n  B -->|Yes| C[OK]\n  B -->|No| D[Rethink]'

/**
 * 1: code only. 2: + theme/viewMode. 3: + width/height (t113). 4: + the shared
 * settings set — fit mode, maximum height, alignment, background, pan/zoom — and
 * `theme` widened to accept `app` (follow the application's own light/dark
 * theme). See MermaidSettings.ts, which owns every one of those.
 */
export const MERMAID_VERSION = 4

/** Debounce delay (ms) before re-rendering the preview while typing. */
const RENDER_DEBOUNCE_MS = 400

/**
 * Elements inside the block that own their own clicks. A click on one of these
 * must not be turned into a block selection, or the focus the user just asked
 * for would be taken away again.
 */
const INTERACTIVE_IN_BLOCK =
  'input, textarea, select, button, a, label, [data-mermaid-width-section="true"], [data-mermaid-settings]'

// Lazily loaded mermaid singleton so the heavy library is code-split and only
// fetched when a diagram is actually rendered.
let mermaidPromise: Promise<typeof import('mermaid').default> | undefined
function loadMermaid(): Promise<typeof import('mermaid').default> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => m.default)
  }
  return mermaidPromise
}

let renderSeq = 0

/**
 * The VISUAL flowchart builder: a form over the diagram's NODES and LINKS that
 * regenerates mermaid source as it changes, shown beside the live diagram (the
 * `graphical` view mode is a two-pane layout exactly as `split` is — a builder
 * you cannot see the result of is not a visual builder, and that is what this
 * pane used to be).
 *
 * THREE RULES, because the thing that goes wrong here is destroying someone's
 * diagram:
 *
 *  1. NOTHING IS DROPPED SILENTLY. Frontmatter, comments and styling statements
 *     round-trip verbatim through the model's `preamble`/`extras`; node shapes
 *     and link kinds are modelled rather than flattened. What is being preserved
 *     is listed in the pane, so the user can see it survived.
 *  2. WHAT IT CANNOT MODEL, IT REFUSES TO TOUCH. A sequence diagram, a subgraph,
 *     an unreadable statement — the builder renders no editing control at all,
 *     names the diagram type and the exact blocking lines, and offers one
 *     explicitly confirmed "replace" action. It used to start from an empty
 *     model, so a single click on "Add node" replaced a whole sequence diagram.
 *  3. A RENAME RENAMES EVERY REFERENCE. Renaming a node used to leave its links
 *     pointing at an id that no longer existed, and unknown links are dropped on
 *     generation — so correcting a name silently deleted the connections.
 */
function GraphicalBuilder({
  code,
  onCodeChange,
}: {
  code: string
  onCodeChange: (next: string) => void
}): React.JSX.Element {
  // What the CURRENT source is, and whether it can be modelled at all. Derived
  // from the code on every change, so the blocked state can never be stale.
  const analysis = useMemo(() => analyzeMermaidSource(code), [code])

  // The form's own model. Derived from the source, but held locally while the
  // user types: regenerating the source on every keystroke and re-seeding from
  // it would fight the fields (an emptied label is re-filled from the id on
  // generation, so it could never be cleared).
  const [model, setModel] = useState<MermaidGraphModel>(() => analysis.model ?? createEmptyGraphModel())
  const lastEmittedRef = useRef<string>('')
  const [confirmingReplace, setConfirmingReplace] = useState(false)

  // Re-seed when the source changes from the OUTSIDE — undo/redo, a template, a
  // hand edit in the code pane, a collaborative change. This is the source ->
  // builder half of the round trip.
  useEffect(() => {
    if (code === lastEmittedRef.current) {
      return
    }
    if (analysis.model) {
      setModel(analysis.model)
    }
    setConfirmingReplace(false)
  }, [code, analysis])

  const commit = useCallback(
    (next: MermaidGraphModel) => {
      setModel(next)
      const source = buildFlowchartSource(next)
      lastEmittedRef.current = source
      onCodeChange(source)
    },
    [onCodeChange],
  )

  const addNode = useCallback(() => commit(appendGraphNode(model)), [model, commit])

  const updateNode = useCallback(
    (index: number, patch: Partial<MermaidGraphNode>) => {
      // An id change is a RENAME, not a field write: every link that referenced
      // the old id has to follow it, or generation drops the link.
      const renamed = typeof patch.id === 'string' ? renameGraphNode(model, index, patch.id) : model
      const rest: Partial<MermaidGraphNode> = { ...patch }
      delete rest.id
      const nodes = renamed.nodes.map((node, i) => (i === index ? { ...node, ...rest } : node))
      commit({ ...renamed, nodes })
    },
    [model, commit],
  )

  const removeNode = useCallback((index: number) => commit(removeGraphNode(model, index)), [model, commit])

  const addEdge = useCallback(() => commit(appendGraphEdge(model)), [model, commit])

  const updateEdge = useCallback(
    (index: number, patch: Partial<MermaidGraphEdge>) => {
      commit({ ...model, edges: model.edges.map((e, i) => (i === index ? { ...e, ...patch } : e)) })
    },
    [model, commit],
  )

  const removeEdge = useCallback(
    (index: number) => {
      commit({ ...model, edges: model.edges.filter((_, i) => i !== index) })
    },
    [model, commit],
  )

  const setDirection = useCallback(
    (direction: MermaidGraphDirection) => {
      commit({ ...model, direction })
    },
    [model, commit],
  )

  const replaceWithFlowchart = useCallback(() => {
    setConfirmingReplace(false)
    commit(appendGraphNode(createEmptyGraphModel()))
  }, [commit])

  const inputClass =
    'min-w-0 flex-1 rounded border border-border bg-default px-1 py-0.5 text-foreground outline-none focus:border-info'
  const selectClass =
    'rounded border border-border bg-default px-1 py-0.5 text-foreground outline-none focus:border-info'

  // RULE 2 — the source cannot be modelled, so the builder renders no editing
  // control whatsoever. There is nothing here that can overwrite the diagram by
  // accident; the only way forward is the confirmed replace below.
  if (analysis.model == null) {
    const typeLabel = MERMAID_DIAGRAM_TYPE_LABELS[analysis.type] ?? 'diagram'
    return (
      <div className="w-full p-2 text-sm" data-mermaid-graphical="blocked" data-srn-print-exclude="true">
        <div className="border-warning bg-contrast text-foreground mb-2 flex items-start gap-2 rounded border p-2 text-xs">
          <span aria-hidden="true" className="mt-px flex">
            <Icon type="warning" size="small" />
          </span>
          <div className="min-w-0">
            <div className="font-semibold">The visual builder cannot edit this diagram</div>
            <p className="mt-1">
              It models <strong>flowcharts</strong> — nodes, links, shapes and direction. This source is a{' '}
              <strong>{typeLabel}</strong>, so nothing here will touch it. Switch the Source control to{' '}
              <strong>code</strong> or <strong>split</strong> to edit it by hand.
            </p>
            <ul className="mt-1 list-disc pl-4" data-mermaid-blockers="true">
              {analysis.blockers.map((blocker, index) => (
                <li key={index}>{blocker}</li>
              ))}
            </ul>
          </div>
        </div>
        {confirmingReplace ? (
          <div className="border-danger bg-contrast flex flex-wrap items-center gap-2 rounded border p-2 text-xs">
            <span>
              This <strong>discards the current source</strong> and starts an empty flowchart. Undo restores it.
            </span>
            <button
              type="button"
              className="border-danger text-danger hover:bg-contrast rounded border px-2 py-0.5"
              onClick={replaceWithFlowchart}
            >
              Discard and start a flowchart
            </button>
            <button
              type="button"
              className="border-border hover:bg-contrast rounded border px-2 py-0.5"
              onClick={() => setConfirmingReplace(false)}
            >
              Keep my diagram
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="border-border hover:bg-contrast rounded border px-2 py-0.5 text-xs"
            onClick={() => setConfirmingReplace(true)}
          >
            Replace it with a new flowchart…
          </button>
        )}
      </div>
    )
  }

  const preserved = [...(model.preamble ?? []), ...(model.extras ?? [])].filter((line) => line.trim().length > 0)
  const dangling = danglingExtras(model)

  return (
    <div className="w-full p-2 text-sm" data-mermaid-graphical="true">
      <label className="mb-2 flex items-center gap-1">
        Direction
        <select
          className={selectClass}
          value={model.direction}
          onChange={(e) => setDirection(e.target.value as MermaidGraphDirection)}
          aria-label="Flowchart direction"
        >
          {MERMAID_GRAPH_DIRECTIONS.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </label>

      <div className="mb-3">
        <div className="mb-1 flex items-center justify-between">
          <span className="font-semibold">Nodes</span>
          <button
            type="button"
            className="border-border hover:bg-contrast rounded border px-2 py-0.5"
            onClick={addNode}
          >
            + Add node
          </button>
        </div>
        {model.nodes.length === 0 ? (
          <div className="text-passive-1 text-xs" data-srn-print-exclude="true">
            No nodes yet.
          </div>
        ) : null}
        <div className="flex flex-col gap-1">
          {model.nodes.map((node, index) => (
            <div key={index} className="flex items-center gap-1">
              <input
                className={inputClass + ' max-w-[6rem]'}
                value={node.id}
                spellCheck={false}
                onChange={(e) => updateNode(index, { id: e.target.value })}
                placeholder="id"
                aria-label={`Node ${index + 1} id`}
              />
              <input
                className={inputClass}
                value={node.label}
                onChange={(e) => updateNode(index, { label: e.target.value })}
                placeholder="Label"
                aria-label={`Node ${index + 1} label`}
              />
              {/* The SHAPE, which the builder used to flatten to a box on the
                  first edit — a decision rhombus silently became a rectangle. */}
              <select
                className={selectClass}
                value={node.shape ?? DEFAULT_MERMAID_NODE_SHAPE}
                onChange={(e) => updateNode(index, { shape: e.target.value as MermaidNodeShape })}
                aria-label={`Node ${index + 1} shape`}
              >
                {MERMAID_NODE_SHAPES.map((shape) => (
                  <option key={shape} value={shape}>
                    {MERMAID_NODE_SHAPE_LABELS[shape]}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="text-danger hover:bg-contrast flex rounded px-1.5 py-1"
                onClick={() => removeNode(index)}
                aria-label={`Remove node ${index + 1}`}
                title="Remove node"
              >
                {/* A real glyph rather than the bare cross character this used to
                    print. The accessible name is the aria-label above either way,
                    so the mark itself is decorative and belongs in the icon set. */}
                <Icon type="close" size="small" />
              </button>
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="font-semibold">Links</span>
          <button
            type="button"
            className="border-border hover:bg-contrast rounded border px-2 py-0.5 disabled:opacity-50"
            onClick={addEdge}
            disabled={model.nodes.length === 0}
          >
            + Add link
          </button>
        </div>
        {model.edges.length === 0 ? (
          <div className="text-passive-1 text-xs" data-srn-print-exclude="true">
            No links yet.
          </div>
        ) : null}
        <div className="flex flex-col gap-1">
          {model.edges.map((edge, index) => (
            <div key={index} className="flex items-center gap-1">
              <select
                className={selectClass}
                value={edge.from}
                onChange={(e) => updateEdge(index, { from: e.target.value })}
                aria-label={`Edge ${index + 1} from`}
              >
                {model.nodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.id}
                  </option>
                ))}
              </select>
              {/* The link KIND — the half of the connector the builder used to
                  normalize to a plain arrow, turning a dotted or thick link into
                  a solid one on the first edit. */}
              <select
                className={selectClass}
                value={edge.kind ?? DEFAULT_MERMAID_EDGE_KIND}
                onChange={(e) => updateEdge(index, { kind: e.target.value as MermaidEdgeKind })}
                aria-label={`Edge ${index + 1} style`}
              >
                {MERMAID_EDGE_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {MERMAID_EDGE_KIND_LABELS[kind]}
                  </option>
                ))}
              </select>
              <select
                className={selectClass}
                value={edge.to}
                onChange={(e) => updateEdge(index, { to: e.target.value })}
                aria-label={`Edge ${index + 1} to`}
              >
                {model.nodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.id}
                  </option>
                ))}
              </select>
              <input
                className={inputClass}
                value={edge.label}
                onChange={(e) => updateEdge(index, { label: e.target.value })}
                placeholder="Label (optional)"
                aria-label={`Edge ${index + 1} label`}
              />
              <button
                type="button"
                className="text-danger hover:bg-contrast flex rounded px-1.5 py-1"
                onClick={() => removeEdge(index)}
                aria-label={`Remove edge ${index + 1}`}
                title="Remove edge"
              >
                <Icon type="close" size="small" />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* RULE 1, made visible: the lines the builder keeps but does not model.
          Showing them is the difference between "preserved" and "you have to
          take our word for it". */}
      {preserved.length > 0 ? (
        <details
          className="border-border text-passive-1 mt-3 rounded border p-1.5 text-xs"
          data-mermaid-preserved="true"
        >
          <summary className="cursor-pointer">
            {preserved.length} line{preserved.length === 1 ? '' : 's'} kept exactly as written (comments, frontmatter,
            styling)
          </summary>
          <pre className="text-foreground mt-1 overflow-x-auto font-mono whitespace-pre">{preserved.join('\n')}</pre>
          {dangling.length > 0 ? (
            <p className="text-danger mt-1" data-mermaid-dangling="true">
              {dangling.length} of them name a node id that no longer exists. They are kept as written — rename the node
              back, or edit them in the code pane.
            </p>
          ) : null}
        </details>
      ) : null}

      <p className="text-passive-1 mt-2 text-xs" data-srn-print-exclude="true">
        Builds flowcharts. Other diagram types open read-only here — use the code pane for those.
      </p>
    </div>
  )
}

function MermaidComponent({
  code,
  settings,
  viewMode,
  width,
  height,
  nodeKey,
}: {
  code: string
  settings: MermaidSettings
  viewMode: MermaidViewMode
  width: string | undefined
  height: number | undefined
  nodeKey: NodeKey
}): React.JSX.Element {
  const [editor] = useLexicalComposerContext()
  // Local draft so typing in the textarea stays snappy; committed to the node
  // (and debounce-rendered) as it changes.
  const [draft, setDraft] = useState(code)
  const [svg, setSvg] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  // Incremented to force a re-render even when the source/theme are unchanged
  // (the Reload button).
  const [reloadToken, setReloadToken] = useState(0)
  // Guards against a late async render overwriting a newer one.
  const renderTokenRef = useRef(0)

  // Keep the draft in sync when the node's code changes from the outside
  // (e.g. undo/redo, collaborative edits).
  useEffect(() => {
    setDraft(code)
  }, [code])

  const render = useCallback(
    async (source: string, activeTheme: MermaidRenderTheme) => {
      const token = ++renderTokenRef.current
      const trimmed = source.trim()
      if (!trimmed) {
        setSvg('')
        setError(null)
        return
      }
      try {
        const mermaid = await loadMermaid()
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: activeTheme.theme,
          // The APPLICATION's own design tokens, not mermaid's generic palette.
          // Absent for a pinned built-in theme: measured against mermaid
          // 11.16.1, `initialize` rebuilds its config from the defaults rather
          // than accumulating, so a pinned diagram rendered after an app-themed
          // one gets mermaid's own clean palette (`mainBkg` back to `#ECECFF`)
          // and not the previous diagram's overrides.
          themeVariables: activeTheme.themeVariables,
          fontFamily: 'inherit',
        })
        const id = `mermaid-${nodeKey}-${renderSeq++}`
        const { svg: rendered } = await mermaid.render(id, trimmed)
        // Drop the result if a newer render started in the meantime.
        if (token !== renderTokenRef.current) {
          return
        }
        setSvg(rendered)
        setError(null)
      } catch (e) {
        if (token !== renderTokenRef.current) {
          return
        }
        // Keep the last good diagram; show the error inline so a bad keystroke
        // never crashes the editor.
        setError(e instanceof Error ? e.message : String(e))
      }
    },
    [nodeKey],
  )

  // The APPLICATION's live theme — its polarity AND its palette — which is what
  // the default `app` theme mode follows. The subscription (a stylesheet
  // finishing load, `<head>` gaining or losing one, an inline-style palette, the
  // OS preference) lives in MermaidAppTheme.ts, whose header says why each of
  // those is needed and which one the previous observer was missing.
  const appTheme: MermaidAppTheme = useMermaidAppTheme()

  const activeTheme = resolveMermaidRenderTheme(settings.themeMode, appTheme)
  // The identity of what reaches mermaid, so the render effect below re-runs on a
  // palette change and ONLY on one. `activeTheme` is a fresh object every
  // render, so it cannot be a dependency itself.
  const activeThemeKey = JSON.stringify(activeTheme)

  // Debounced render whenever the draft, resolved theme, or reload token changes.
  // THE live-theme path: a theme switch changes `activeThemeKey`, which
  // re-renders the diagram. Mermaid caches nothing across `render()` calls, but
  // this component does — `svg` is held in state and the viewport injects it
  // once per change — so without a new render the old SVG stays on screen with
  // the old theme's colours baked into its own `<style>`.
  useEffect(() => {
    const handle = window.setTimeout(() => {
      void render(draft, activeTheme)
    }, RENDER_DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, activeThemeKey, reloadToken, render])

  // Invalidate any in-flight render when the component unmounts.
  useEffect(() => {
    return () => {
      renderTokenRef.current++
    }
  }, [])

  const persistCode = useCallback(
    (next: string) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey)
        if ($isMermaidNode(node)) {
          node.setCode(next)
        }
      })
    },
    [editor, nodeKey],
  )

  const onCodeChange = useCallback(
    (next: string) => {
      setDraft(next)
      persistCode(next)
    },
    [persistCode],
  )

  const reload = useCallback(() => {
    setReloadToken((t) => t + 1)
  }, [])

  // --- Selection gating for the size controls -------------------------------
  // The table's own selected-only control (TableCellActionMenuPlugin) renders
  // nothing until the Lexical selection resolves to a table cell. This is the
  // decorator-node spelling of that rule, as RemoteImageComponent does it
  // (RemoteImageComponent.tsx:109-130), with two deliberate differences — see
  // the handler below.
  const blockRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const [isSelected, setSelected] = useLexicalNodeSelection(nodeKey)

  useEffect(() => {
    return editor.registerCommand<MouseEvent>(
      CLICK_COMMAND,
      (event) => {
        const target = event.target as Element | null
        if (!target || !blockRef.current?.contains(target)) {
          return false
        }
        // (1) A click on one of the block's OWN controls changes no selection.
        // Unlike an image block, this one is full of real form fields — the
        // mermaid source textarea, the theme/template/view selects, the width
        // field — and moving the editor's selection on those clicks would pull
        // focus straight back out of whatever the user just clicked into. That
        // is also why nothing here calls `event.preventDefault()` or
        // `node.selectEnd()`: both would fight the focused field.
        const onOwnControl = typeof target.closest === 'function' && target.closest(INTERACTIVE_IN_BLOCK) !== null
        if (!onOwnControl) {
          // (2) Select, never toggle. The image block toggles, which would make
          // the controls vanish on a second click — exactly while being used.
          // Deferred to a macrotask so this nested update does not run inside
          // the command dispatch that is already updating the editor.
          setTimeout(() => setSelected(true))
        }
        // (3) Consume the click EITHER WAY. Handing it back to Lexical would let
        // its own click handling put a range selection in the editor, which both
        // dismisses these controls while they are being used and moves the caret
        // out of the field just clicked. Because `preventDefault` is never
        // called, the browser still focuses that field natively.
        return true
      },
      COMMAND_PRIORITY_LOW,
    )
  }, [editor, setSelected])

  const onResizeEnd = useCallback(
    (nextWidth: string | undefined, nextHeight: number | undefined) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey)
        if ($isMermaidNode(node)) {
          node.setWidth(nextWidth)
          node.setHeight(nextHeight)
        }
      })
    },
    [editor, nodeKey],
  )

  const widthUnit: MermaidWidthUnit = parseMermaidWidth(width)?.unit ?? '%'

  // Replace the entire source from the Templates dropdown.
  const applyTemplate = useCallback(
    (templateId: string) => {
      const source = MERMAID_TEMPLATES.find((t) => t.id === templateId)?.source
      if (source == null) {
        return
      }
      setDraft(source)
      persistCode(source)
    },
    [persistCode],
  )

  const showCode = viewMode === 'split' || viewMode === 'code'
  // The BUILDER SHOWS THE DIAGRAM. `graphical` used to be the one mode with no
  // preview at all, so the "visual" builder was a blind form: you edited nodes
  // and links and saw nothing until you switched modes. It is a two-pane layout
  // exactly as `split` is — the editing surface on one side, the live diagram on
  // the other.
  const showPreview = viewMode === 'split' || viewMode === 'preview' || viewMode === 'graphical'
  const showGraphical = viewMode === 'graphical'
  const isTwoPane = viewMode === 'split' || viewMode === 'graphical'

  return (
    <div
      ref={blockRef}
      className="border-border bg-default my-2 rounded border"
      data-mermaid-block="true"
      data-super-widget-layout="canvas"
      // `width` is undefined unless the user set one — fitting is the DEFAULT,
      // not a stored number — and `maxWidth` means a stored pixel width can
      // never make the note scroll horizontally. The alignment margins only bite
      // on a block narrower than the column, which is the only case with slack.
      style={{ width, maxWidth: '100%', ...mermaidAlignmentStyle(settings.alignment) }}
    >
      {/* THE CHART'S OWN TOP BAR — the block's identity, plus the two actions on
          its SOURCE: pick a template, re-render. No configuration. Every mermaid
          setting now has exactly ONE home, the editor toolbar's Mermaid section
          (ToolbarPlugin), which appears while the diagram is selected; the user
          asked for it not to be offered twice. The shared control definitions
          (MermaidSettingsPanel, and `mermaidSettingsControls`, which the toolbar
          renders from) are untouched, and its `bar` arrangement is still built
          and still tested — restoring this surface, or a chosen subset of it, is
          a matter of mounting that component again. */}
      <div
        className="border-border text-passive-1 flex flex-wrap items-center justify-between gap-2 border-b px-2 py-1 text-xs"
        data-mermaid-top-bar="true"
      >
        <span className="font-semibold">Mermaid diagram</span>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1">
            Templates
            <select
              className="border-border bg-default text-foreground focus:border-info rounded border px-1 py-0.5 outline-none"
              value=""
              onChange={(e) => {
                if (e.target.value) {
                  applyTemplate(e.target.value)
                }
              }}
              aria-label="Insert a template diagram"
            >
              <option value="" disabled>
                Choose…
              </option>
              {MERMAID_TEMPLATES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="hover:bg-contrast rounded px-2 py-0.5"
            onClick={reload}
            title="Re-render the diagram"
          >
            Reload
          </button>
        </div>
      </div>

      <div className={'flex ' + (isTwoPane ? 'flex-col md:flex-row' : 'flex-col')}>
        {showGraphical ? (
          <div
            className={
              'border-border flex flex-col border-b md:border-b-0 ' + (isTwoPane ? 'md:w-1/2 md:border-r' : 'w-full')
            }
          >
            <GraphicalBuilder code={draft} onCodeChange={onCodeChange} />
          </div>
        ) : null}

        {showCode ? (
          <div className={'flex flex-col ' + (isTwoPane ? 'md:border-border md:w-1/2 md:border-r' : 'w-full')}>
            <textarea
              className="bg-default text-foreground w-full resize-y p-2 font-mono text-sm outline-none"
              rows={Math.max(6, draft.split('\n').length + 1)}
              value={draft}
              spellCheck={false}
              onChange={(e) => onCodeChange(e.target.value)}
              placeholder="Enter mermaid source…"
              aria-label="Mermaid source"
            />
          </div>
        ) : null}

        {showPreview ? (
          <div className={'min-w-0 p-2 ' + (isTwoPane ? 'md:w-1/2' : 'w-full')}>
            {svg ? (
              // An unpadded wrapper so its measured height IS the preview box's
              // height; the resize handle's live feedback and the persisted
              // `height` then refer to the same box.
              <div ref={previewRef}>
                <MermaidSvgViewport
                  svg={svg}
                  heightOverride={height}
                  fitMode={settings.fitMode}
                  // THE configurable maximum that replaced the hardcoded 480:
                  // resolved from the node's own setting, `null` when the user
                  // chose "No limit", and otherwise a share of the window.
                  maxHeightPx={resolveMermaidMaxHeightPx(
                    settings.maxHeight,
                    typeof window === 'undefined' ? undefined : window.innerHeight,
                  )}
                  zoomPan={settings.zoomPan}
                  background={settings.background}
                  // WHICH surface `themed` paints. Not unconditionally the
                  // app's: a diagram pinned to one of mermaid's own themes does
                  // not follow the app, so painting the app's dark surface
                  // behind a light-pinned chart is the thing that made it
                  // unreadable. See resolveMermaidSurfaceColor.
                  backgroundColor={resolveMermaidSurfaceColor(settings.background, settings.themeMode, appTheme)}
                >
                  <MermaidResizeHandle
                    active={isSelected}
                    widthTargetRef={blockRef}
                    heightTargetRef={previewRef}
                    unit={widthUnit}
                    onResizeEnd={onResizeEnd}
                  />
                </MermaidSvgViewport>
              </div>
            ) : (
              !error && (
                <div className="text-passive-1 text-sm" data-srn-print-exclude="true">
                  Empty diagram
                </div>
              )
            )}
            {error ? (
              <div className="text-danger mt-1 text-xs whitespace-pre-wrap" data-srn-print-exclude="true" role="alert">
                {error}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export type SerializedMermaidNode = Spread<
  {
    code: string
    /**
     * The theme MODE. Versions 2-3 stored one of mermaid's own theme names here;
     * version 4 widened it to include `app` (follow the application's theme) and
     * kept the field name.
     *
     * Reading it back is version-gated, and that is the whole of the backward
     * compatibility story: at versions below 4 the field was written as
     * mermaid's light `default` for every diagram the user never configured, so
     * at those versions that one value means "nobody ever asked" and resolves to
     * `app`. Every other name, and `default` from version 4 on, is a deliberate
     * choice and is kept exactly. See `migrateMermaidThemeMode`.
     */
    theme: MermaidThemeMode
    viewMode: MermaidViewMode
    /** Normalized CSS width (`"50%"`, `"420px"`); absent means "fit". */
    width?: string
    /** Preview-box height in px; absent means "auto-fit". */
    height?: number
    /** Version 4 — see MermaidSettings.ts. Absent fields take their defaults. */
    fitMode?: MermaidSettings['fitMode']
    /** A px number, or `"none"`. Absent means "follow the window". */
    maxHeight?: MermaidMaxHeight
    alignment?: MermaidSettings['alignment']
    background?: MermaidSettings['background']
    zoomPan?: boolean
  },
  SerializedLexicalNode
>

/** The version-4 settings a caller may seed, other than the theme mode. */
export type MermaidExtraSettings = Partial<Omit<MermaidSettings, 'themeMode'>>

export class MermaidNode extends DecoratorNode<React.JSX.Element> {
  __code: string
  __viewMode: MermaidViewMode
  /**
   * Every configurable setting, already resolved: the ONE place the block's own
   * top bar and the editor toolbar's Mermaid section both read and write. The
   * theme mode lives in here too (it is a setting like any other); the SERIALIZED
   * field keeps its historical name `theme`.
   */
  __settings: MermaidSettings
  /** Normalized CSS width, or undefined for "fit the container". */
  __width: string | undefined
  /** Preview-box height in px, or undefined for "auto-fit". */
  __height: number | undefined

  static getType(): string {
    return 'mermaid'
  }

  static clone(node: MermaidNode): MermaidNode {
    return new MermaidNode(
      node.__code,
      node.__settings.themeMode,
      node.__viewMode,
      node.__width,
      node.__height,
      node.__settings,
      node.__key,
    )
  }

  constructor(
    code: string,
    themeMode: MermaidThemeMode = DEFAULT_MERMAID_THEME_MODE,
    viewMode: MermaidViewMode = DEFAULT_MERMAID_VIEW_MODE,
    width?: string,
    height?: number,
    settings?: MermaidExtraSettings,
    key?: NodeKey,
  ) {
    super(key)
    this.__code = code
    this.__viewMode = viewMode
    // THE single validation point for the settings, for exactly the reason the
    // size has one: every creation path funnels through here, and each field is a
    // SYNCED value an older build or a hand edit may have written. Anything
    // unparseable becomes its default rather than reaching a style attribute or
    // mermaid's own config.
    this.__settings = resolveMermaidSettings({ ...settings, themeMode })
    // THE single validation point for an incoming size, deliberately not
    // duplicated in importJSON: every creation path — $createMermaidNode,
    // clone(), importJSON — funnels through here, and a stored size is a SYNCED
    // value another client, an older build or a hand edit may have written. It
    // is re-parsed and re-clamped, and anything unparseable becomes `undefined`
    // (fit the container) rather than reaching a style attribute. The only other
    // way `__width`/`__height` can change is setWidth/setHeight, which normalize
    // the same way.
    this.__width = normalizeMermaidWidth(width)
    this.__height = normalizeMermaidHeight(height)
  }

  static importJSON(serializedNode: SerializedMermaidNode): MermaidNode {
    // Backward-compatible: old nodes (version 1) stored only `code`; theme and
    // viewMode are absent and fall back to defaults. Some very old serializations
    // may even be a bare string — guard against that too.
    const raw = serializedNode as unknown
    if (typeof raw === 'string') {
      return $createMermaidNode(raw)
    }
    const code = typeof serializedNode.code === 'string' ? serializedNode.code : DEFAULT_MERMAID
    const viewMode = normalizeMermaidViewMode(serializedNode.viewMode) ?? DEFAULT_MERMAID_VIEW_MODE
    // The stored size and settings are handed straight to the constructor, which
    // is the one place that parses and clamps them (see the comment there).
    // Normalizing here as well would be dead code that makes the real guard
    // untestable: with two layers, removing either one changes nothing
    // observable. The theme is passed through unvalidated for the same reason —
    // `resolveMermaidSettings` is what decides whether a stored theme is one it
    // recognizes, and what an unrecognized one falls back to.
    //
    // The ONE translation the theme does get is the version-gated migration:
    // every build before version 4 wrote mermaid's light `default` theme into
    // the note whether or not the user had chosen anything, so an existing
    // diagram could never follow the app. `migrateMermaidThemeMode` turns that
    // one value, at those versions only, into `app`; every deliberate choice —
    // any other name, and `default` at version 4 or later, where `app` was on
    // offer — is handed through unchanged.
    return $createMermaidNode(
      code,
      migrateMermaidThemeMode(serializedNode.theme, serializedNode.version) as MermaidThemeMode,
      viewMode,
      serializedNode.width,
      serializedNode.height,
      {
        fitMode: serializedNode.fitMode,
        maxHeight: serializedNode.maxHeight,
        alignment: serializedNode.alignment,
        background: serializedNode.background,
        zoomPan: serializedNode.zoomPan,
      },
    )
  }

  exportJSON(): SerializedMermaidNode {
    return {
      type: 'mermaid',
      version: MERMAID_VERSION,
      code: this.__code,
      theme: this.__settings.themeMode,
      viewMode: this.__viewMode,
      width: this.__width,
      height: this.__height,
      fitMode: this.__settings.fitMode,
      // Written only when the user actually chose one: absent means "follow the
      // window", and writing the resolved pixel number would freeze today's
      // window height into the note.
      maxHeight: this.__settings.maxHeight,
      alignment: this.__settings.alignment,
      background: this.__settings.background,
      zoomPan: this.__settings.zoomPan,
    }
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement('pre')
    element.setAttribute('data-lexical-mermaid', 'true')
    const codeEl = document.createElement('code')
    codeEl.className = 'language-mermaid'
    codeEl.textContent = this.__code
    element.appendChild(codeEl)
    return { element }
  }

  createDOM(): HTMLElement {
    const div = document.createElement('div')
    div.style.display = 'contents'
    return div
  }

  updateDOM(): false {
    return false
  }

  getCode(): string {
    return this.getLatest().__code
  }

  setCode(code: string): void {
    this.getWritable().__code = code
  }

  /** The theme MODE (`app`, or one of mermaid's own theme names). */
  getTheme(): MermaidThemeMode {
    return this.getLatest().__settings.themeMode
  }

  setTheme(themeMode: MermaidThemeMode): void {
    this.setSettings({ themeMode })
  }

  /** Every setting, resolved. The shape the toolbar section renders from. */
  getSettings(): MermaidSettings {
    return this.getLatest().__settings
  }

  /**
   * Apply a partial settings change. Re-resolves the whole object, so a setter is
   * no more trusted than an import: this is the only other way `__settings` can
   * change, and it normalizes the same way the constructor does.
   */
  setSettings(patch: Partial<MermaidSettings>): void {
    const writable = this.getWritable()
    const merged = { ...writable.__settings, ...patch }
    writable.__settings = resolveMermaidSettings(merged)
  }

  getViewMode(): MermaidViewMode {
    return this.getLatest().__viewMode
  }

  setViewMode(viewMode: MermaidViewMode): void {
    this.getWritable().__viewMode = viewMode
  }

  getWidth(): string | undefined {
    return this.getLatest().__width
  }

  /** Normalizes on write, so `__width` is never a value nothing validated. */
  setWidth(width: string | undefined): void {
    this.getWritable().__width = normalizeMermaidWidth(width)
  }

  getHeight(): number | undefined {
    return this.getLatest().__height
  }

  setHeight(height: number | undefined): void {
    this.getWritable().__height = normalizeMermaidHeight(height)
  }

  getTextContent(): string {
    return '```mermaid\n' + this.__code + '\n```'
  }

  isInline(): false {
    return false
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): React.JSX.Element {
    return (
      <MermaidComponent
        code={this.__code}
        settings={this.__settings}
        viewMode={this.__viewMode}
        width={this.__width}
        height={this.__height}
        nodeKey={this.getKey()}
      />
    )
  }
}

export function $createMermaidNode(
  code = DEFAULT_MERMAID,
  themeMode: MermaidThemeMode = DEFAULT_MERMAID_THEME_MODE,
  viewMode: MermaidViewMode = DEFAULT_MERMAID_VIEW_MODE,
  width?: string,
  height?: number,
  settings?: MermaidExtraSettings,
): MermaidNode {
  return new MermaidNode(code, themeMode, viewMode, width, height, settings)
}

export function $isMermaidNode(node: LexicalNode | null | undefined): node is MermaidNode {
  return node instanceof MermaidNode
}
