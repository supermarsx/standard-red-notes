// The visual builder's OPERATIONS, checked against the REAL mermaid.
//
// Its sibling, scripts/MermaidFlowEngineContract.mjs, checks that the builder
// reads a flowchart's text the way the installed mermaid does. This script
// checks what the builder WRITES: every operation in MermaidFlowEdits.ts, tried
// on every text of the corpus, with the installed library — not the builder's
// own reading — saying what the result means.
//
// Five things are held, each by a named check:
//
//   - no operation is ever "altered": mermaid either reads the result as
//     exactly what was asked, or the operation was refused, by name, and the
//     text was not touched. An operation whose result mermaid rejects, or reads
//     as something else, fails the run;
//   - what mermaid reads afterwards is stated a second time here, by code that
//     shares nothing with the operation's own expectation;
//   - an accepted operation changes only the lines it owns;
//   - the four ways the previous builder changed a diagram without saying so,
//     and the `linkStyle` failure, cannot happen;
//   - what the builder writes, mermaid DRAWS. Reading is not drawing: mermaid
//     reads `A(-x-)` as an ellipse and then has no shape to draw it with, so
//     the last checks call `mermaid.render` on what the builder wrote.
//
// MermaidFlowEditsContract.spec.ts starts it as a child process, so it runs
// wherever `yarn test` runs, and reads its exit code and the JSON summary on
// its last line.
//
//   node scripts/MermaidFlowEditsContract.mjs          what the gate runs: a few operations of every kind per text
//   node scripts/MermaidFlowEditsContract.mjs --all    every operation on every box, link and group of every text
import {
  api,
  assert,
  contractKit,
  installLayoutStandIns,
  lines,
  mermaid,
  NODES,
  quoted,
  same,
} from './MermaidUnderNode.mjs'

const FlowDoc = await import(`${NODES}/MermaidFlowDoc.ts`)
await FlowDoc.loadMermaidFlowGrammar()
const Oracle = await import(`${NODES}/MermaidOracle.ts`)
const Edits = await import(`${NODES}/MermaidFlowEdits.ts`)
const Corpus = await import(`${NODES}/MermaidFlowCorpus.fixture.ts`)
const plainLabel = (await import(`${NODES}/MermaidSourceDoc.ts`)).plainMermaidLabel

const everything = process.argv.includes('--all')
const { counts, check, finish } = contractKit()
const commonNames = new Set(Corpus.MERMAID_FLOW_COMMON_FORMS.map((entry) => entry.name))

/**
 * How much of a diagram the operations are tried on. `all` is every box, link
 * and group; the gate tries every KIND of operation on every text, on the
 * first few of each, and more of them on the 37 common forms.
 */
const LEVELS = {
  all: {
    nodes: Infinity,
    shapes: 4,
    names: 2,
    labels: 2,
    linked: 2,
    groups: Infinity,
    pairs: 3,
    edges: Infinity,
    restyles: 7,
    newGroups: 3,
    directions: 2,
  },
  common: {
    nodes: 2,
    shapes: 1,
    names: 1,
    labels: 2,
    linked: 2,
    groups: 1,
    pairs: 1,
    edges: 2,
    restyles: 4,
    newGroups: 3,
    directions: 2,
  },
  sample: {
    nodes: 1,
    shapes: 1,
    names: 1,
    labels: 1,
    linked: 1,
    groups: 1,
    pairs: 1,
    edges: 1,
    restyles: 3,
    newGroups: 2,
    directions: 1,
  },
}

// Mermaid is configured once, as the app's own reading configures it, and the
// bulk of what follows asks it directly: several thousand readings, each of
// which would otherwise reset and configure the library again. The app's own
// path through MermaidRuntime's queue is what the named checks at the end use.
api.reset()
mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' })
const FLOWCHART_TYPES = new Set(['flowchart', 'flowchart-v2'])
const readDirectly = async (text) => {
  try {
    const diagram = await api.getDiagramFromText(text)
    if (!FLOWCHART_TYPES.has(diagram.type)) {
      return {
        ok: false,
        kind: 'not-flowchart',
        diagramType: diagram.type,
        message: `This is a ${diagram.type} diagram.`,
      }
    }
    return { ok: true, reading: Oracle.mermaidFlowReadingFromDatabase(diagram.db) }
  } catch (error) {
    return { ok: false, kind: 'rejected', message: String(error?.message ?? error) }
  }
}

// ===========================================================================
// 1. The operations: every kind, on every corpus text, judged by mermaid.
// ===========================================================================

/** A reading with what is derived from order taken out: group members sorted. */
const settled = (reading) => ({
  ...reading,
  groups: reading.groups.map((group) => ({ ...group, nodes: [...group.nodes].sort() })),
})
const nodeMap = (reading) => new Map(reading.nodes.map((node) => [node.id, JSON.stringify(node)]))
const edgeTexts = (reading) => reading.edges.map((edge) => JSON.stringify(edge))
const groupTexts = (reading) => settled(reading).groups.map((group) => JSON.stringify(group))
const withoutIndex = (list, index) => list.filter((_entry, at) => at !== index)

/**
 * What must be true of mermaid's reading after an operation, said a second
 * time and by other code than the operation's own expectation. Each returns
 * the problems it found. They are deliberately plain: the same boxes, the same
 * links, the same groups, except the one thing that was asked for.
 */
const sameNodes = (before, after, except = new Set(), ordered = true) => {
  const problems = []
  const a = nodeMap(before)
  const b = nodeMap(after)
  for (const [id, text] of a) {
    if (!except.has(id) && b.get(id) !== text) {
      problems.push(`box ${id} was ${text} and is ${b.get(id)}`)
    }
  }
  for (const id of b.keys()) {
    if (!a.has(id) && !except.has(id)) {
      problems.push(`a box ${id} appeared`)
    }
  }
  if (ordered) {
    const order = (reading) => reading.nodes.map((node) => node.id).filter((id) => !except.has(id))
    if (!same(order(before), order(after))) {
      problems.push(`the boxes changed order: ${order(before)} to ${order(after)}`)
    }
  }
  return problems
}
const sameEdges = (before, after) =>
  same(edgeTexts(before), edgeTexts(after)) ? [] : [`links were ${edgeTexts(before)} and are ${edgeTexts(after)}`]
const sameGroups = (before, after) =>
  same(groupTexts(before), groupTexts(after)) ? [] : [`groups were ${groupTexts(before)} and are ${groupTexts(after)}`]
const sameRest = (before, after) =>
  same(
    [before.direction, before.classes, before.defaultLinkStyle ?? null, before.defaultInterpolate ?? null],
    [after.direction, after.classes, after.defaultLinkStyle ?? null, after.defaultInterpolate ?? null],
  )
    ? []
    : ['the direction, the named styles or the default link style changed']
const renamed = (reading, from, to) => {
  const name = (id) => (id === from ? to : id)
  return {
    ...reading,
    nodes: reading.nodes.map((node) => ({ ...node, id: name(node.id) })),
    edges: reading.edges.map((edge) => ({ ...edge, start: name(edge.start), end: name(edge.end) })),
    groups: reading.groups.map((group) => ({ ...group, nodes: group.nodes.map(name) })),
  }
}

/** Lines of the source — counted from 0 — that are not in the result, by longest common subsequence. */
const linesRemoved = (source, result) => {
  const a = source.split(/\r\n|\n|\r/)
  const b = result.split(/\r\n|\n|\r/)
  const table = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const removed = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      removed.push(i++)
    } else {
      j++
    }
  }
  while (i < a.length) {
    removed.push(i++)
  }
  return removed
}

/** The lines an operation may change or remove, worked out from the document as it was. */
const linesOf = (document) => {
  const span = (statement) => {
    const lines = []
    for (let line = statement.line; line <= statement.endLine; line++) {
      lines.push(line)
    }
    return lines
  }
  const naming = (ids) =>
    document.statements.flatMap((statement) => {
      if (
        statement.kind === 'vertex' &&
        statement.groups.some((group) => group.some((mention) => ids.has(mention.id)))
      ) {
        return span(statement)
      }
      if (statement.kind === 'style' && ids.has(statement.target)) {
        return span(statement)
      }
      if ((statement.kind === 'class' || statement.kind === 'click') && statement.targets.some((t) => ids.has(t.id))) {
        return span(statement)
      }
      return []
    })
  return {
    naming,
    linkStyles: () => document.statements.filter((s) => s.kind === 'linkStyle').flatMap(span),
    ofEdge: (index) => span(document.statements[document.edges[index].statement]),
    header: () => [mermaidLine(document, document.header.keywordSpan.start)],
    group: (id) => {
      const group = document.statements.find((s) => s.kind === 'group' && s.id === id)
      const inside = document.statements.filter((s) => s.kind === 'direction' && s.parent === group.index).flatMap(span)
      return [mermaidLine(document, group.opening.start), mermaidLine(document, group.closing.start), ...inside]
    },
  }
}
const mermaidLine = (document, offset) => {
  let line = 0
  while (line + 1 < document.lines.length && document.lines[line + 1].start <= offset) {
    line++
  }
  return line
}

/**
 * Every operation worth trying on a diagram, from mermaid's reading of it.
 * Each carries the lines it may touch and a second statement of what it must
 * leave true. `level` says how many boxes, links and groups each kind of
 * operation is tried on (LEVELS, above).
 */
function operationsFor(reading, document, level) {
  const owned = linesOf(document)
  const nodes = reading.nodes.map((node) => node.id).filter((id) => !reading.groups.some((group) => group.id === id))
  const groups = reading.groups.map((group) => group.id)
  const edgeIds = (indices) => new Set(indices.map((index) => reading.edges[index].id).filter(Boolean))
  const groupOf = (id) => reading.groups.find((group) => group.nodes.includes(id))?.id ?? null
  const operations = []
  const add = (kind, name, edit, owns, verify) => operations.push({ kind, name, edit, owns, verify })

  const someNodes = nodes.slice(0, level.nodes)
  for (const id of someNodes) {
    const named = () => owned.naming(new Set([id]))
    for (const label of ['New label', 'Say "hi" & (go) [now]'].slice(0, level.labels)) {
      add('relabel', `relabel ${id} "${label}"`, Edits.relabelMermaidFlowNode(id, label), named, (before, after) => [
        ...sameNodes(before, after, new Set([id])),
        ...sameEdges(before, after),
        ...sameGroups(before, after),
        ...sameRest(before, after),
        ...(plainLabel(after.nodes.find((node) => node.id === id)?.text ?? '') === plainLabel(label)
          ? []
          : [`${id} reads "${after.nodes.find((node) => node.id === id)?.text}"`]),
      ])
    }
    for (const shape of ['lean_right', 'round', 'hexagon', 'doublecircle'].slice(0, level.shapes)) {
      add('reshape', `reshape ${id} ${shape}`, Edits.reshapeMermaidFlowNode(id, shape), named, (before, after) => {
        const was = before.nodes.find((node) => node.id === id)
        const is = after.nodes.find((node) => node.id === id)
        return [
          ...sameNodes(before, after, new Set([id])),
          ...sameEdges(before, after),
          ...sameGroups(before, after),
          ...sameRest(before, after),
          ...(is?.type === shape && plainLabel(is.text) === plainLabel(was.text) && same(is.classes, was.classes)
            ? []
            : [`${id} is ${JSON.stringify(is)}`]),
        ]
      })
    }
    for (const name of ['other', 'Renamed'].slice(0, level.names)) {
      add('rename', `rename ${id} ${name}`, Edits.renameMermaidFlowNode(id, name), named, (before, after) => {
        const expected = renamed(before, id, name)
        return [
          ...sameNodes(expected, after, new Set([name])),
          ...sameEdges(expected, after),
          ...sameGroups(expected, after),
          ...sameRest(before, after),
          ...(after.nodes.some((node) => node.id === name) && !after.nodes.some((node) => node.id === id)
            ? []
            : [`${id} is still there, or ${name} is not`]),
        ]
      })
    }
    const touching = reading.edges
      .map((edge, index) => (edge.start === id || edge.end === id ? index : -1))
      .filter((i) => i >= 0)
    add(
      'delete',
      `delete ${id}`,
      Edits.deleteMermaidFlowNode(id),
      () => [...owned.naming(new Set([id, ...edgeIds(touching)])), ...owned.linkStyles()],
      (before, after) => {
        const expected = {
          ...before,
          nodes: before.nodes.filter((node) => node.id !== id),
          edges: before.edges.filter((edge) => edge.start !== id && edge.end !== id),
          groups: before.groups.map((group) => ({ ...group, nodes: group.nodes.filter((member) => member !== id) })),
        }
        return [
          ...sameNodes(expected, after),
          ...sameEdges(expected, after),
          ...sameGroups(expected, after),
          ...sameRest(before, after),
        ]
      },
    )
    for (const [direction, options] of [
      ['from', { label: 'Next step', linkFrom: id }],
      ['to', { label: 'Before', linkTo: id, shape: 'diamond', linkLabel: 'then' }],
    ].slice(0, level.linked)) {
      add(
        'add a linked box',
        `add a box linked ${direction} ${id}`,
        Edits.addMermaidFlowNode(options),
        owned.linkStyles,
        (before, after) => {
          const made = after.nodes.filter((node) => !before.nodes.some((was) => was.id === node.id))
          if (made.length !== 1) {
            return [`${made.length} boxes were made`]
          }
          const [box] = made
          const index = after.edges.findIndex((edge) => (direction === 'from' ? edge.end : edge.start) === box.id)
          const link = after.edges[index]
          const expectedGroups = before.groups.map((group) =>
            group.id === groupOf(id) ? { ...group, nodes: [...group.nodes, box.id] } : group,
          )
          return [
            ...sameNodes(before, after, new Set([box.id])),
            ...(index >= 0 && (direction === 'from' ? link.start : link.end) === id
              ? []
              : ['the new link is not there']),
            ...sameEdges(before, { ...after, edges: withoutIndex(after.edges, index) }),
            ...sameGroups({ ...before, groups: expectedGroups }, after),
            ...sameRest(before, after),
            ...(plainLabel(box.text) === options.label && box.type === (options.shape ?? 'square')
              ? []
              : [`the new box is ${JSON.stringify(box)}`]),
          ]
        },
      )
    }
    for (const group of [null, ...groups.slice(0, level.groups)]) {
      add(
        'move',
        `move ${id} to ${group ?? 'no group'}`,
        Edits.moveMermaidFlowNode(id, group),
        () => [...owned.naming(new Set([id])), ...owned.linkStyles()],
        (before, after) => {
          const expectedGroups = before.groups.map((entry) => ({
            ...entry,
            nodes: [...entry.nodes.filter((member) => member !== id), ...(entry.id === group ? [id] : [])],
          }))
          return [
            ...sameNodes(before, after, new Set(), false),
            ...(same([...edgeTexts(before)].sort(), [...edgeTexts(after)].sort())
              ? []
              : ['the links are not the same links']),
            ...sameGroups({ ...before, groups: expectedGroups }, after),
            ...sameRest(before, after),
          ]
        },
      )
    }
  }

  for (const [name, options] of [
    ['add a box', { label: 'Alone' }],
    ['add a shaped box', { label: 'Is it "ok"?', shape: 'hexagon' }],
    ...groups.slice(0, level.groups).map((group) => [`add a box in ${group}`, { label: 'Inside', group }]),
  ]) {
    add(
      'add a box',
      name,
      Edits.addMermaidFlowNode(options),
      () => [],
      (before, after) => {
        const made = after.nodes.filter((node) => !before.nodes.some((was) => was.id === node.id))
        const expectedGroups = before.groups.map((group) =>
          group.id === options.group ? { ...group, nodes: [...group.nodes, made[0]?.id] } : group,
        )
        return [
          ...(made.length === 1 && plainLabel(made[0].text) === plainLabel(options.label)
            ? []
            : [`made ${JSON.stringify(made)}`]),
          ...sameNodes(before, after, new Set(made.map((node) => node.id))),
          ...sameEdges(before, after),
          ...sameGroups({ ...before, groups: expectedGroups }, after),
          ...sameRest(before, after),
        ]
      },
    )
  }

  const pairs = []
  for (const from of nodes.slice(0, level.pairs)) {
    for (const to of nodes.slice(-level.pairs)) {
      pairs.push([from, to])
    }
  }
  for (const [from, to] of pairs) {
    for (const [name, options] of [
      ['link', {}],
      ['link, styled', { look: { stroke: 'dotted', ends: 'circle', length: 2 }, label: 'maybe (x)' }],
    ]) {
      add(
        'link',
        `${name} ${from} to ${to}`,
        Edits.addMermaidFlowLink(from, to, options),
        owned.linkStyles,
        (before, after) => {
          const index = after.edges.findIndex((edge, at) =>
            same(edgeTexts(before), edgeTexts({ edges: withoutIndex(after.edges, at) })),
          )
          const link = after.edges[index]
          return [
            ...(index >= 0 && link.start === from && link.end === to
              ? []
              : ['the links are not the old ones plus the new one']),
            ...(link &&
            link.stroke === (options.look?.stroke ?? 'normal') &&
            plainLabel(link.text) === (options.label ?? '')
              ? []
              : [`the new link is ${JSON.stringify(link)}`]),
            ...sameNodes(before, after, new Set([from, to])),
            ...sameNodes(before, after, new Set(), false),
            ...sameGroups(before, after),
            ...sameRest(before, after),
          ]
        },
      )
    }
  }

  const someEdges = reading.edges.map((_edge, index) => index).slice(0, level.edges)
  for (const index of someEdges) {
    const edge = reading.edges[index]
    const ofEdge = () => [...owned.ofEdge(index), ...owned.linkStyles(), ...owned.naming(edgeIds([index]))]
    add('unlink', `unlink ${index}`, Edits.removeMermaidFlowLink(index), ofEdge, (before, after) => [
      ...sameNodes(before, after),
      ...sameEdges({ ...before, edges: withoutIndex(before.edges, index) }, after),
      ...sameGroups(before, after),
      ...sameRest(before, after),
    ])
    for (const [end, target] of [
      ['to', nodes[0]],
      ['from', nodes[nodes.length - 1]],
    ]) {
      add(
        'retarget',
        `retarget ${index} ${end} ${target}`,
        Edits.retargetMermaidFlowLink(index, { [end]: target }),
        ofEdge,
        (before, after) => {
          const expected = before.edges.map((entry, at) =>
            at === index ? { ...entry, [end === 'to' ? 'end' : 'start']: target } : entry,
          )
          return [
            ...sameNodes(before, after, new Set(), false),
            ...sameEdges({ ...before, edges: expected }, after),
            ...sameGroups(before, after),
            ...sameRest(before, after),
          ]
        },
      )
    }
    const restyles = [
      ['thick', { stroke: 'thick' }, { stroke: 'thick' }],
      ['open', { ends: 'none' }, { type: 'arrow_open' }],
      ['long', { length: 3 }, { length: 3 }],
      ['label', { label: 'yes' }, { text: 'yes' }],
      ['awkward label', { label: 'a -- b | "c"' }, { text: 'a -- b | "c"' }],
      ['no label', { label: '' }, { text: '' }],
      [
        'everything',
        { stroke: 'dotted', ends: 'both-arrows', length: 2, label: 'both' },
        { stroke: 'dotted', type: 'double_arrow_point', length: 2, text: 'both' },
      ],
    ]
    for (const [name, change, wanted] of restyles.slice(0, level.restyles)) {
      add(
        'restyle',
        `restyle ${index} ${name}`,
        Edits.restyleMermaidFlowLink(index, change),
        ofEdge,
        (before, after) => {
          const is = after.edges[index]
          const drawnAsAsked =
            is !== undefined &&
            is.start === edge.start &&
            is.end === edge.end &&
            Object.entries(wanted).every(([field, value]) =>
              field === 'text' ? plainLabel(is.text) === value : is[field] === value || edge.stroke === 'invisible',
            )
          return [
            ...(drawnAsAsked ? [] : [`link ${index} is ${JSON.stringify(is)}`]),
            ...sameNodes(before, after),
            ...sameEdges(
              { ...before, edges: withoutIndex(before.edges, index) },
              { ...after, edges: withoutIndex(after.edges, index) },
            ),
            ...sameGroups(before, after),
            ...sameRest(before, after),
          ]
        },
      )
    }
  }

  for (const [name, members] of [
    ['group the first box', nodes.slice(0, 1)],
    ['group the first two boxes', nodes.slice(0, 2)],
    ['an empty group', []],
  ].slice(0, level.newGroups)) {
    add(
      'group',
      name,
      Edits.addMermaidFlowGroup({ title: 'Two "of" them', members }),
      () => [],
      (before, after) => {
        const made = after.groups.filter((group) => !before.groups.some((was) => was.id === group.id))
        const parent = members.length > 0 ? groupOf(members[0]) : null
        const expectedGroups = before.groups.map((group) =>
          group.id === parent
            ? { ...group, nodes: [...group.nodes.filter((member) => !members.includes(member)), made[0]?.id] }
            : group,
        )
        return [
          ...(made.length === 1 &&
          same([...made[0].nodes].sort(), [...members].sort()) &&
          plainLabel(made[0].title) === 'Two "of" them'
            ? []
            : [`made ${JSON.stringify(made)}`]),
          ...sameNodes(before, after),
          ...sameEdges(before, after),
          ...sameGroups(
            { ...before, groups: expectedGroups },
            { ...after, groups: after.groups.filter((group) => !made.includes(group)) },
          ),
          ...sameRest(before, after),
        ]
      },
    )
  }
  for (const id of groups) {
    add(
      'ungroup',
      `ungroup ${id}`,
      Edits.removeMermaidFlowGroup(id),
      () => [...owned.group(id), ...owned.naming(new Set([id]))],
      (before, after) => {
        const gone = before.groups.find((group) => group.id === id)
        const expectedGroups = before.groups
          .filter((group) => group.id !== id)
          .map((group) =>
            group.nodes.includes(id)
              ? { ...group, nodes: [...group.nodes.filter((member) => member !== id), ...gone.nodes] }
              : group,
          )
        return [
          ...sameNodes({ ...before, nodes: before.nodes.filter((node) => node.id !== id) }, after),
          ...sameEdges(before, after),
          ...sameGroups({ ...before, groups: expectedGroups }, after),
          ...sameRest(before, after),
        ]
      },
    )
    add(
      'retitle',
      `retitle ${id}`,
      Edits.retitleMermaidFlowGroup(id, 'Another title'),
      () => owned.group(id).slice(0, 1),
      (before, after) => {
        const is = after.groups.find((group) => group.id === id)
        const blank = (reading) => ({
          ...reading,
          groups: reading.groups.map((group) => (group.id === id ? { ...group, title: '', labelType: '' } : group)),
        })
        return [
          ...(is && plainLabel(is.title) === 'Another title' ? [] : [`group ${id} is ${JSON.stringify(is)}`]),
          ...sameNodes(before, after),
          ...sameEdges(before, after),
          ...sameGroups(blank(before), blank(after)),
          ...sameRest(before, after),
        ]
      },
    )
  }
  for (const direction of ['LR', 'TD'].slice(0, level.directions)) {
    add(
      'direction',
      `direction ${direction}`,
      Edits.setMermaidFlowDirection(direction),
      owned.header,
      (before, after) => [
        ...(after.direction === (direction === 'TD' ? 'TB' : direction) ? [] : [`direction is ${after.direction}`]),
        ...sameNodes(before, after),
        ...sameEdges(before, after),
        ...sameGroups(before, after),
        ...sameRest({ ...before, direction: after.direction }, after),
      ],
    )
  }
  return operations
}

const OPERATION_KINDS = [
  'relabel',
  'reshape',
  'rename',
  'delete',
  'add a box',
  'add a linked box',
  'link',
  'unlink',
  'retarget',
  'restyle',
  'group',
  'ungroup',
  'retitle',
  'move',
  'direction',
]

/** One run of the operations over the corpus, read by the four checks below. */
const trial = {
  attempted: 0,
  accepted: 0,
  refused: 0,
  /** Outcomes that are neither: mermaid rejected the result, or read it as something else. */
  altered: [],
  /** Accepted, and mermaid's reading is not what the second statement says it must be. */
  wrong: [],
  /** Accepted, and a line the operation does not own is gone. */
  trespassed: [],
  /** Accepted, and the result is a text the builder no longer reads the way mermaid does. */
  stranded: [],
  byKind: Object.fromEntries(OPERATION_KINDS.map((kind) => [kind, { accepted: 0, refused: 0 }])),
  reasons: new Map(),
  commonForms: new Map(),
}
{
  const cache = new Map()
  const read = async (text) => {
    if (!cache.has(text)) {
      cache.set(text, await readDirectly(text))
    }
    return cache.get(text)
  }
  for (const { name, source } of Corpus.MERMAID_FLOW_CORPUS) {
    const isCommon = commonNames.has(name)
    const before = await read(source)
    const document = FlowDoc.parseMermaidFlowSource(source)
    if (!before.ok || document.problem) {
      trial.altered.push(`${name}: not readable to begin with`)
      continue
    }
    const form = { accepted: 0, refused: [] }
    const level = everything ? LEVELS.all : isCommon ? LEVELS.common : LEVELS.sample
    for (const operation of operationsFor(before.reading, document, level)) {
      trial.attempted++
      const outcome = await Oracle.applyMermaidFlowEdit(source, operation.edit, read)
      const label = `${name} :: ${operation.name}`
      if (!outcome.ok) {
        if (outcome.stage !== 'refused') {
          trial.altered.push(`${label}: ${outcome.stage}: ${outcome.reason} ${outcome.details.slice(0, 2).join(' ; ')}`)
          continue
        }
        trial.refused++
        trial.byKind[operation.kind].refused++
        form.refused.push(`${operation.name}: ${outcome.reason}`)
        const reason = outcome.reason.replace(/"[^"]*"/g, '"…"').replace(/\(.*\)/, '(…)')
        trial.reasons.set(reason, (trial.reasons.get(reason) ?? 0) + 1)
        continue
      }
      trial.accepted++
      trial.byKind[operation.kind].accepted++
      form.accepted++
      const problems = operation.verify(before.reading, outcome.reading)
      if (problems.length > 0) {
        trial.wrong.push(`${label}: ${problems.slice(0, 2).join(' ; ')} — wrote ${quoted(outcome.text)}`)
      }
      // Compared by what a line says: of two identical lines, a diff may name
      // either one as the line that went.
      const written = source.split(/\r\n|\n|\r/)
      const owned = new Set(operation.owns().map((line) => written[line]))
      const strayed = linesRemoved(source, outcome.text).filter((line) => !owned.has(written[line]))
      if (strayed.length > 0) {
        trial.trespassed.push(
          `${label}: changed line ${strayed[0] + 1} (${JSON.stringify(written[strayed[0]])}) — wrote ${quoted(outcome.text)}`,
        )
      }
      const again = FlowDoc.parseMermaidFlowSource(outcome.text)
      const differences = again.reading
        ? FlowDoc.compareMermaidFlowReadings(again.reading, outcome.reading)
        : ['not read']
      if (differences.length > 0) {
        trial.stranded.push(`${label}: ${differences[0]}`)
      }
    }
    if (isCommon) {
      trial.commonForms.set(name, form)
    }
  }
}

await check(
  'every operation on every corpus text is judged by mermaid: accepted, or refused by name — never altered',
  async () => {
    assert(
      trial.altered.length === 0,
      `${trial.altered.length} operations were rejected by mermaid or changed the diagram's meaning: ${trial.altered.slice(0, 3).join(' || ')}`,
    )
    for (const kind of OPERATION_KINDS) {
      assert(
        trial.byKind[kind].accepted > 0,
        `no "${kind}" operation was accepted anywhere: it has stopped being tested`,
      )
    }
    assert(trial.accepted >= 1500, `only ${trial.accepted} operations were accepted`)
    counts.operations = trial.attempted
    counts.operationsAccepted = trial.accepted
    counts.operationsRefused = trial.refused
    counts.operationsAltered = trial.altered.length
    counts.operationKinds = OPERATION_KINDS.filter((kind) => trial.byKind[kind].accepted > 0).length
    const reasons = [...trial.reasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `${count} × ${reason}`)
    return `${trial.attempted} operations: ${trial.accepted} accepted, ${trial.refused} refused, 0 altered. Refusals: ${reasons.join(' | ')}`
  },
)

await check(
  'after an accepted operation mermaid reads what was asked and nothing else — said a second time, by other code',
  async () => {
    assert(trial.wrong.length === 0, `${trial.wrong.length}: ${trial.wrong.slice(0, 3).join(' || ')}`)
    assert(
      trial.stranded.length === 0,
      `${trial.stranded.length} results the builder could not go on editing: ${trial.stranded.slice(0, 3).join(' || ')}`,
    )
    return `${trial.accepted} results`
  },
)

await check('an accepted operation changes only the lines it owns', async () => {
  assert(trial.trespassed.length === 0, `${trial.trespassed.length}: ${trial.trespassed.slice(0, 3).join(' || ')}`)
  return `${trial.accepted} results`
})

await check(
  'of the 37 common forms: every one edited, some with operations refused by name, none altered',
  async () => {
    const forms = [...trial.commonForms.entries()]
    assert(forms.length === Corpus.MERMAID_FLOW_COMMON_FORMS.length, `${forms.length} forms were tried`)
    const edited = forms.filter(([, form]) => form.accepted > 0)
    const withRefusals = forms.filter(([, form]) => form.refused.length > 0)
    assert(
      edited.length === forms.length,
      `not edited at all: ${forms.filter(([, form]) => form.accepted === 0).map(([name]) => name)}`,
    )
    counts.commonFormsEdited = edited.length
    counts.commonFormsWithARefusal = withRefusals.length
    counts.commonFormsAltered = 0
    return `${edited.length} edited; ${withRefusals.length} with at least one operation refused by name (${withRefusals
      .map(([name, form]) => `${name}: ${form.refused.length}`)
      .join(', ')}); 0 altered`
  },
)

// ===========================================================================
// 5. The corruptions the old builder made, by name.
// ===========================================================================
const BACKSLASH = String.fromCharCode(92)
const readingAfter = async (source, edit) => {
  const outcome = await Oracle.applyMermaidFlowEdit(source, edit)
  assert(outcome.ok, `refused (${outcome.stage}): ${outcome.reason} ${(outcome.details ?? []).join(' ; ')}`)
  return outcome
}
/** Each box's shape and text, in id order: an operation may move a box in mermaid's order without changing what it is. */
const shapesOf = (reading) =>
  reading.nodes.map((node) => [node.id, node.type, node.text]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))

await check(
  'corruption 1 cannot happen: a slanted box or a trapezoid stays what it is through every operation',
  async () => {
    const source = lines(
      'flowchart TD',
      `  A[/Input/] --> B[${BACKSLASH}Output${BACKSLASH}]`,
      `  C[/Wide${BACKSLASH}] --> D[${BACKSLASH}Narrow/]`,
    )
    const slanted = [
      ['A', 'lean_right', 'Input'],
      ['B', 'lean_left', 'Output'],
      ['C', 'trapezoid', 'Wide'],
      ['D', 'inv_trapezoid', 'Narrow'],
    ]
    const before = await Oracle.readMermaidFlowchart(source)
    assert(
      before.ok && same(shapesOf(before.reading), slanted),
      `mermaid reads ${JSON.stringify(before.reading?.nodes)}`,
    )
    const edits = [
      Edits.addMermaidFlowNode({ label: 'New', id: 'N' }),
      Edits.addMermaidFlowNode({ label: 'New', id: 'N', linkFrom: 'A' }),
      Edits.addMermaidFlowLink('A', 'D'),
      Edits.removeMermaidFlowLink(0),
      Edits.retargetMermaidFlowLink(0, { to: 'D' }),
      Edits.restyleMermaidFlowLink(1, { stroke: 'dotted', label: 'x' }),
      Edits.addMermaidFlowGroup({ title: 'G', members: ['A', 'B'] }),
      Edits.setMermaidFlowDirection('LR'),
    ]
    for (const edit of edits) {
      const { reading, text } = await readingAfter(source, edit)
      assert(
        same(
          shapesOf(reading).filter(([id]) => id !== 'N'),
          slanted,
        ),
        `after ${quoted(text)} mermaid reads ${JSON.stringify(shapesOf(reading))}`,
      )
    }
    const relabelled = await readingAfter(source, Edits.relabelMermaidFlowNode('B', 'Out'))
    assert(
      same(shapesOf(relabelled.reading)[1], ['B', 'lean_left', 'Out']),
      JSON.stringify(shapesOf(relabelled.reading)),
    )
    const reshaped = await readingAfter(source, Edits.reshapeMermaidFlowNode('A', 'inv_trapezoid'))
    assert(
      same(shapesOf(reshaped.reading)[0], ['A', 'inv_trapezoid', 'Input']),
      JSON.stringify(shapesOf(reshaped.reading)),
    )
    return `${edits.length + 2} operations`
  },
)

await check('corruption 2 cannot happen: a double circle stays a double circle labelled as it was', async () => {
  const source = lines('flowchart LR', '  A(((Stop))) --> B')
  for (const edit of [
    Edits.addMermaidFlowNode({ label: 'Next', linkFrom: 'B' }),
    Edits.removeMermaidFlowLink(0),
    Edits.renameMermaidFlowNode('B', 'End'),
    Edits.restyleMermaidFlowLink(0, { stroke: 'thick' }),
  ]) {
    const { reading, text } = await readingAfter(source, edit)
    assert(
      same(shapesOf(reading)[0], ['A', 'doublecircle', 'Stop']),
      `after ${quoted(text)}: ${JSON.stringify(shapesOf(reading))}`,
    )
  }
  const relabelled = await readingAfter(source, Edits.relabelMermaidFlowNode('A', 'Halt'))
  assert(
    same(shapesOf(relabelled.reading)[0], ['A', 'doublecircle', 'Halt']),
    JSON.stringify(shapesOf(relabelled.reading)),
  )
  return '5 operations'
})

await check(
  'corruption 3 cannot happen: a label given twice keeps the later one, and a relabel changes the one that counts',
  async () => {
    const source = lines('flowchart LR', '  A[Start] --> B', '  A[Renamed later]')
    for (const edit of [
      Edits.addMermaidFlowNode({ label: 'New', linkFrom: 'B' }),
      Edits.addMermaidFlowLink('B', 'A'),
      Edits.reshapeMermaidFlowNode('B', 'round'),
      Edits.setMermaidFlowDirection('TD'),
    ]) {
      const { reading, text } = await readingAfter(source, edit)
      assert(reading.nodes[0].text === 'Renamed later', `after ${quoted(text)} A reads "${reading.nodes[0].text}"`)
    }
    const relabelled = await readingAfter(source, Edits.relabelMermaidFlowNode('A', 'Final'))
    assert(relabelled.reading.nodes[0].text === 'Final', `A reads "${relabelled.reading.nodes[0].text}"`)
    assert(relabelled.text === lines('flowchart LR', '  A[Start] --> B', '  A[Final]'), quoted(relabelled.text))
    return '5 operations'
  },
)

await check(
  'corruption 4 cannot happen: renaming a box never passes through, or lands on, another box’s name',
  async () => {
    const source = lines('flowchart LR', '  A --> B', '  C --> A')
    const { reading, text } = await readingAfter(source, Edits.renameMermaidFlowNode('B', 'A2'))
    assert(text === lines('flowchart LR', '  A --> A2', '  C --> A'), quoted(text))
    assert(
      same(
        reading.edges.map((edge) => [edge.start, edge.end]),
        [
          ['A', 'A2'],
          ['C', 'A'],
        ],
      ),
      JSON.stringify(reading.edges),
    )
    const merged = await Oracle.applyMermaidFlowEdit(source, Edits.renameMermaidFlowNode('B', 'A'))
    assert(
      !merged.ok && merged.stage === 'refused' && /already a box called "A"/.test(merged.reason),
      JSON.stringify(merged),
    )
    return 'B to A2 keeps A’s links; B to A is refused'
  },
)

await check(
  'a link that goes takes its number with it: every surviving link keeps the style it had, for every operation that removes links',
  async () => {
    const styled = [
      lines(
        'flowchart LR',
        '  A --> B',
        '  B --> C',
        '  C --> D',
        '  linkStyle 1 stroke:#f00',
        '  linkStyle 0,2 stroke:#0f0',
      ),
      lines(
        'flowchart LR',
        '  A --> B --> C & D',
        '  D --> A',
        '  linkStyle 0 stroke:#f00',
        '  linkStyle 2,3 stroke:#00f,stroke-width:2px',
      ),
      lines(
        'flowchart TB',
        '  subgraph one',
        '    a1 --> a2',
        '    a2 --> a3',
        '  end',
        '  c1 --> a2',
        '  linkStyle 0 stroke:#f00',
        '  linkStyle 2 stroke:#0f0',
      ),
      lines(
        'flowchart LR',
        '  A --> B',
        '  B --> C',
        '  linkStyle 1 interpolate basis stroke:#f00',
        '  linkStyle default stroke-width:3px',
      ),
    ]
    const identity = (edge) =>
      `${edge.start}>${edge.end}:${JSON.stringify(edge.style ?? null)}:${edge.interpolate ?? ''}`
    let removals = 0
    for (const source of styled) {
      const before = await Oracle.readMermaidFlowchart(source)
      assert(before.ok, before.message)
      const edits = [
        ...before.reading.edges.map((_edge, index) => ({
          name: `removing link ${index}`,
          edit: Edits.removeMermaidFlowLink(index),
          survives: (_entry, at) => at !== index,
        })),
        ...before.reading.nodes.map((node) => ({
          name: `deleting ${node.id}`,
          edit: Edits.deleteMermaidFlowNode(node.id),
          survives: (entry) => entry.start !== node.id && entry.end !== node.id,
        })),
        ...before.reading.nodes.map((node) => ({
          name: `moving ${node.id} out of its group`,
          edit: Edits.moveMermaidFlowNode(node.id, null),
          survives: () => true,
          anyOrder: true,
        })),
      ]
      for (const { name, edit, survives, anyOrder } of edits) {
        const outcome = await Oracle.applyMermaidFlowEdit(source, edit)
        assert(
          outcome.ok || outcome.stage === 'refused',
          `${name}: ${outcome.stage}: ${outcome.reason} — ${quoted(source)}`,
        )
        if (!outcome.ok) {
          continue
        }
        const expected = before.reading.edges.filter(survives).map(identity)
        const actual = outcome.reading.edges.map(identity)
        assert(
          anyOrder ? same([...expected].sort(), [...actual].sort()) : same(expected, actual),
          `${name}: the links were ${JSON.stringify(expected)} and are ${JSON.stringify(actual)} — wrote ${quoted(outcome.text)}`,
        )
        removals++
      }
    }
    assert(removals >= 25, `only ${removals} removals were accepted`)
    counts.styledRemovals = removals
    return `${removals} operations over ${styled.length} styled diagrams`
  },
)

await check('the defect is real in this mermaid: a linkStyle past the last link stops the diagram', async () => {
  // What every renumbering above is for. If a later mermaid tolerated it, the
  // renumbering would be guarding nothing, and this is where that is noticed.
  const broken = await Oracle.readMermaidFlowchart(lines('flowchart LR', '  A --> B', '  linkStyle 1 stroke:#f00'))
  assert(!broken.ok && broken.kind === 'rejected', `mermaid read it: ${JSON.stringify(broken).slice(0, 200)}`)
  return broken.message.split('\n')[0]
})

await check(
  'a text with configuration the app does not honour comes through every operation with those lines untouched',
  async () => {
    const entry = Corpus.MERMAID_FLOW_CORPUS.find(
      (candidate) => candidate.name === 'configuration the app does not honour',
    )
    assert(entry, 'the corpus has lost the entry this check is about')
    const head = entry.source.slice(0, entry.source.indexOf('flowchart LR'))
    for (const key of ['themeCSS', 'fontFamily', 'htmlLabels', 'actorFontFamily']) {
      assert(head.includes(key), `the fixture no longer sets ${key}`)
    }
    const before = await Oracle.readMermaidFlowchart(entry.source)
    assert(before.ok, before.message)
    let accepted = 0
    for (const operation of operationsFor(before.reading, FlowDoc.parseMermaidFlowSource(entry.source), LEVELS.all)) {
      const outcome = await Oracle.applyMermaidFlowEdit(entry.source, operation.edit)
      if (!outcome.ok) {
        assert(outcome.stage === 'refused', `${operation.name}: ${outcome.stage}: ${outcome.reason}`)
        continue
      }
      accepted++
      assert(
        outcome.text.startsWith(head),
        `${operation.name} changed the frontmatter or the directive: ${quoted(outcome.text)}`,
      )
    }
    assert(accepted >= 40, `only ${accepted} operations were accepted on it`)
    counts.lockedConfigOperations = accepted
    return `${accepted} operations, ${head.length} characters of configuration identical after each`
  },
)

// ===========================================================================
// Drawing. Everything above asks mermaid what a text MEANS. These ask it to
// draw what the builder wrote, because the two can differ: the grammar reads a
// form the renderer has no shape for, the database says nothing is wrong, and
// the diagram is an error on the page.
// ===========================================================================

installLayoutStandIns()
const LOOKS = [
  ['classic', { look: 'classic' }],
  ['hand-drawn', { look: 'handDrawn', handDrawnSeed: 7 }],
]
let drawings = 0
/** Draw a text with the installed mermaid; null when it draws, mermaid's own words when it does not. */
const drawingProblem = async (text, config) => {
  // The app's own path configures mermaid for each reading, so the look is set
  // again before every drawing.
  api.reset()
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', ...config })
  try {
    const { svg } = await mermaid.render(`edits-contract-${drawings++}`, text)
    return svg.includes('<svg') ? null : 'mermaid returned no picture'
  } catch (error) {
    return String(error?.message ?? error).split('\n')[0]
  }
}

await check(
  'every shape the builder can give a box is one mermaid draws, in the classic and the hand-drawn look',
  async () => {
    const shapes = Object.keys(Edits.MERMAID_FLOW_BRACKET_SHAPES)
    assert(shapes.length >= 14, `only ${shapes.length} shapes are offered`)
    let drawn = 0
    for (const shape of shapes) {
      // Set on a box that is there, and given to a new one: the two ways a shape is written.
      const reshaped = await Oracle.applyMermaidFlowEdit(
        lines('flowchart LR', '  A[Start] --> B'),
        Edits.reshapeMermaidFlowNode('A', shape),
      )
      const added = await Oracle.applyMermaidFlowEdit(
        lines('flowchart LR', '  A --> B'),
        Edits.addMermaidFlowNode({ label: 'Is it "new"?', shape, linkFrom: 'B' }),
      )
      for (const [how, outcome] of [
        ['set', reshaped],
        ['added', added],
      ]) {
        assert(outcome.ok, `${shape} ${how}: ${outcome.stage}: ${outcome.reason}`)
        for (const [look, config] of LOOKS) {
          const problem = await drawingProblem(outcome.text, config)
          assert(
            problem === null,
            `the builder writes ${quoted(outcome.text)} for "${shape}", and mermaid cannot draw it (${look}): ${problem}`,
          )
          drawn++
        }
      }
    }
    counts.shapesDrawn = shapes.length
    counts.shapeDrawings = drawn
    return `${shapes.length} shapes, each set and added, ${drawn} drawings`
  },
)

await check('the defect is real in this mermaid: it reads an ellipse and cannot draw it', async () => {
  // Why the ellipse is not a shape the builder writes. If a later mermaid
  // draws it, this fails, and the shape can go back on the list.
  const said = []
  const undrawn = Object.entries(Edits.MERMAID_FLOW_UNDRAWN_SHAPES)
  assert(undrawn.length > 0, 'no shape is listed as read and not drawn: this check is guarding nothing')
  for (const [shape, [open, close]] of undrawn) {
    const text = lines('flowchart LR', `  A${open}Label${close} --> B`)
    const reading = await Oracle.readMermaidFlowchart(text)
    assert(reading.ok, `mermaid no longer reads ${quoted(text)}: ${reading.message}`)
    assert(
      reading.reading.nodes[0].type === shape,
      `mermaid reads ${quoted(text)} as "${reading.reading.nodes[0].type}", not "${shape}"`,
    )
    for (const [look, config] of LOOKS) {
      const problem = await drawingProblem(text, config)
      assert(
        problem !== null,
        `mermaid now draws "${shape}" (${look}): move it from MERMAID_FLOW_UNDRAWN_SHAPES to MERMAID_FLOW_BRACKET_SHAPES`,
      )
      assert(/No such shape/.test(problem), `mermaid fails on "${shape}" (${look}) for another reason: ${problem}`)
      said.push(problem)
    }
    // And the builder will not write it, however it is asked.
    for (const edit of [Edits.reshapeMermaidFlowNode('B', shape), Edits.addMermaidFlowNode({ label: 'Oval', shape })]) {
      const outcome = await Oracle.applyMermaidFlowEdit(text, edit)
      assert(
        !outcome.ok && outcome.stage === 'refused',
        `the builder wrote a "${shape}": ${quoted(outcome.ok ? outcome.text : outcome.reason)}`,
      )
    }
    // It can be given a shape that draws: the repair.
    const repaired = await Oracle.applyMermaidFlowEdit(text, Edits.reshapeMermaidFlowNode('A', 'stadium'))
    assert(repaired.ok, `an "${shape}" could not be reshaped: ${repaired.reason}`)
    assert((await drawingProblem(repaired.text, LOOKS[0][1])) === null, `${quoted(repaired.text)} still does not draw`)
  }
  counts.shapesReadAndNotDrawn = undrawn.length
  return said[0]
})

finish({ everything })
