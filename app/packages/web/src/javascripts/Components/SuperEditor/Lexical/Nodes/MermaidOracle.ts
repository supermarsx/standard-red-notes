/**
 * Standard Red Notes — mermaid as the JUDGE of every edit the builder makes.
 *
 * The builder changes a diagram by changing its text, and the builder it
 * replaces changed a diagram's meaning four different ways without saying so,
 * because the only thing that checked its work was its own parser. Here nothing
 * the builder writes is accepted on the builder's say-so:
 *
 *   before   = what mermaid reads from the text as it is
 *   expected = before, with exactly what the edit was asked to do applied
 *   after    = what mermaid reads from the edited text
 *
 * and the edit is kept only if mermaid accepts the new text and `after` IS
 * `expected` — the same boxes with the same labels, shapes, classes and styles,
 * the same links in the same order with the same styles, the same groups with
 * the same members, and nothing else different either. So a recogniser that is
 * wrong cannot corrupt a diagram: the worst it can do is have its edit refused.
 *
 * "What mermaid reads" is its flowchart database, `diagram.db`, as filled by
 * its own parser. That is an INTERNAL API. This file is the only place it is
 * touched (`mermaidFlowReadingFromDatabase`), it refuses a database that is not
 * the shape it was written against rather than reading it loosely, and
 * `scripts/MermaidFlowEngineContract.mjs` runs it against the installed
 * library on every test run — a mermaid upgrade that changes the database has
 * to fail there, loudly, rather than quietly leave the builder with nothing to
 * check itself against.
 */
import {
  compareMermaidFlowReadings,
  loadMermaidFlowGrammar,
  type MermaidFlowDocument,
  type MermaidFlowEdgeReading,
  type MermaidFlowGroupReading,
  type MermaidFlowNodeReading,
  type MermaidFlowReading,
  parseMermaidFlowSource,
} from './MermaidFlowDoc'
import { readMermaidDiagram } from './MermaidRuntime'
import { plainMermaidLabel } from './MermaidSourceDoc'

// ---------------------------------------------------------------------------
// Reading mermaid's database
// ---------------------------------------------------------------------------

/** The diagram kinds mermaid parses with its flowchart grammar and FlowDB. */
const FLOWCHART_TYPES: ReadonlySet<string> = new Set(['flowchart', 'flowchart-v2'])

/** Thrown when mermaid's flowchart database is not the shape this adapter knows. */
export class UnfamiliarMermaidDatabase extends Error {
  constructor(what: string) {
    super(`Mermaid's flowchart database is not the one the builder was written against: ${what}.`)
    this.name = 'UnfamiliarMermaidDatabase'
  }
}

type Loose = Record<string, unknown>

const isObject = (value: unknown): value is Loose => typeof value === 'object' && value !== null

/**
 * A value as plain data: what is left of it when everything that is not data
 * is taken away. Object keys are sorted, so two values that hold the same
 * things compare equal as text whatever order they were filled in.
 */
function plain(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return undefined
  }
  if (depth > 8) {
    return '[too deep]'
  }
  if (Array.isArray(value)) {
    return value.map((entry) => plain(entry, depth + 1) ?? null)
  }
  if (value instanceof Map) {
    return [...value.entries()].map(([key, entry]) => [plain(key, depth + 1) ?? null, plain(entry, depth + 1) ?? null])
  }
  if (value instanceof Set) {
    return [...value.values()].map((entry) => plain(entry, depth + 1) ?? null)
  }
  if (isObject(value)) {
    const result: Loose = {}
    for (const key of Object.keys(value).sort()) {
      const entry = plain(value[key], depth + 1)
      if (entry !== undefined) {
        result[key] = entry
      }
    }
    return result
  }
  return String(value)
}

/** Everything an object carries beyond the named fields, as plain data; undefined when that is nothing. */
function extraOf(value: Loose, known: ReadonlySet<string>): Record<string, unknown> | undefined {
  const extra: Loose = {}
  for (const key of Object.keys(value).sort()) {
    if (known.has(key)) {
      continue
    }
    const entry = plain(value[key])
    // An empty object or list says nothing: mermaid gives every box `props: {}`.
    const isEmpty = isObject(entry) && Object.keys(entry).length === 0
    if (entry !== undefined && !isEmpty) {
      extra[key] = entry
    }
  }
  return Object.keys(extra).length > 0 ? extra : undefined
}

const strings = (value: unknown, what: string): string[] => {
  if (value === undefined || value === null) {
    return []
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new UnfamiliarMermaidDatabase(`${what} is not a list of strings`)
  }
  return [...(value as string[])]
}

const optionalString = (value: unknown, what: string): string | undefined => {
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'string') {
    throw new UnfamiliarMermaidDatabase(`${what} is not text`)
  }
  return value
}

const requiredString = (value: unknown, what: string): string => {
  if (typeof value !== 'string') {
    throw new UnfamiliarMermaidDatabase(`${what} is not text`)
  }
  return value
}

const call = (db: Loose, name: string): unknown => {
  const method = db[name]
  if (typeof method !== 'function') {
    throw new UnfamiliarMermaidDatabase(`it has no ${name}()`)
  }
  return (method as () => unknown).call(db)
}

// `domId` is left out on purpose: it ends in a counter of every mention of
// every box before it, so it changes for boxes an edit never touched.
const VERTEX_FIELDS: ReadonlySet<string> = new Set(['id', 'text', 'type', 'labelType', 'classes', 'styles', 'domId'])
// A generated id (`L_A_B_0`) is left out for the same reason: it is derived
// from the ends and from how many links already join them.
const EDGE_FIELDS: ReadonlySet<string> = new Set([
  'start',
  'end',
  'type',
  'stroke',
  'length',
  'text',
  'labelType',
  'id',
  'isUserDefinedId',
  'classes',
  'style',
  'interpolate',
])
const GROUP_FIELDS: ReadonlySet<string> = new Set(['id', 'title', 'nodes', 'dir', 'labelType', 'classes'])

/**
 * Mermaid's flowchart database as a reading. THE adapter: nothing else in the
 * app knows what a FlowDB looks like.
 */
export function mermaidFlowReadingFromDatabase(database: unknown): MermaidFlowReading {
  if (!isObject(database)) {
    throw new UnfamiliarMermaidDatabase('there is none')
  }
  const vertices = call(database, 'getVertices')
  const edges = call(database, 'getEdges')
  const groups = call(database, 'getSubGraphs')
  const classes = call(database, 'getClasses')
  const direction = call(database, 'getDirection')
  if (!(vertices instanceof Map)) {
    throw new UnfamiliarMermaidDatabase('getVertices() does not return a Map')
  }
  if (!Array.isArray(edges)) {
    throw new UnfamiliarMermaidDatabase('getEdges() does not return a list')
  }
  if (!Array.isArray(groups)) {
    throw new UnfamiliarMermaidDatabase('getSubGraphs() does not return a list')
  }
  if (!(classes instanceof Map)) {
    throw new UnfamiliarMermaidDatabase('getClasses() does not return a Map')
  }

  const nodes: MermaidFlowNodeReading[] = []
  for (const [key, vertex] of vertices as Map<unknown, unknown>) {
    if (!isObject(vertex) || vertex.id !== key) {
      throw new UnfamiliarMermaidDatabase('a box is not filed under its own id')
    }
    const id = requiredString(vertex.id, 'a box’s id')
    const node: MermaidFlowNodeReading = {
      id,
      text: requiredString(vertex.text, `the text of ${id}`),
      type: optionalString(vertex.type, `the shape of ${id}`),
      labelType: requiredString(vertex.labelType, `the label kind of ${id}`),
      classes: strings(vertex.classes, `the classes of ${id}`),
      styles: strings(vertex.styles, `the styles of ${id}`),
    }
    const extra = extraOf(vertex, VERTEX_FIELDS)
    if (extra) {
      node.extra = extra
    }
    nodes.push(node)
  }

  const links: MermaidFlowEdgeReading[] = edges.map((edge: unknown, index: number) => {
    if (!isObject(edge)) {
      throw new UnfamiliarMermaidDatabase(`link ${index} is not an object`)
    }
    const length = edge.length
    if (length !== undefined && typeof length !== 'number') {
      throw new UnfamiliarMermaidDatabase(`the length of link ${index} is not a number`)
    }
    const link: MermaidFlowEdgeReading = {
      start: requiredString(edge.start, `the start of link ${index}`),
      end: requiredString(edge.end, `the end of link ${index}`),
      type: optionalString(edge.type, `the type of link ${index}`),
      stroke: optionalString(edge.stroke, `the stroke of link ${index}`),
      length,
      text: requiredString(edge.text, `the text of link ${index}`),
      labelType: requiredString(edge.labelType, `the label kind of link ${index}`),
      id: edge.isUserDefinedId === true ? requiredString(edge.id, `the id of link ${index}`) : undefined,
      classes: strings(edge.classes, `the classes of link ${index}`),
      style: edge.style === undefined ? undefined : strings(edge.style, `the style of link ${index}`),
      interpolate: optionalString(edge.interpolate, `the curve of link ${index}`),
    }
    const extra = extraOf(edge, EDGE_FIELDS)
    if (extra) {
      link.extra = extra
    }
    return link
  })

  const groupReadings: MermaidFlowGroupReading[] = groups.map((group: unknown, index: number) => {
    if (!isObject(group)) {
      throw new UnfamiliarMermaidDatabase(`group ${index} is not an object`)
    }
    const id = requiredString(group.id, `the id of group ${index}`)
    const reading: MermaidFlowGroupReading = {
      id,
      title: requiredString(group.title, `the title of group ${id}`),
      nodes: strings(group.nodes, `the boxes of group ${id}`),
      dir: optionalString(group.dir, `the direction of group ${id}`),
      labelType: requiredString(group.labelType, `the label kind of group ${id}`),
      classes: strings(group.classes, `the classes of group ${id}`),
    }
    const extra = extraOf(group, GROUP_FIELDS)
    if (extra) {
      reading.extra = extra
    }
    return reading
  })

  const classReadings = [...(classes as Map<unknown, unknown>).values()].map((entry) => {
    if (!isObject(entry)) {
      throw new UnfamiliarMermaidDatabase('a named style is not an object')
    }
    const id = requiredString(entry.id, 'a named style’s id')
    return {
      id,
      styles: strings(entry.styles, `the styles of ${id}`),
      textStyles: strings(entry.textStyles, `the text styles of ${id}`),
    }
  })

  // The link list doubles as the holder of `linkStyle default`.
  const edgeList = edges as unknown as Loose
  const reading: MermaidFlowReading = {
    direction: optionalString(direction, 'the direction'),
    nodes,
    edges: links,
    groups: groupReadings,
    classes: classReadings,
    defaultLinkStyle:
      edgeList.defaultStyle === undefined ? undefined : strings(edgeList.defaultStyle, 'the default link style'),
    defaultInterpolate: optionalString(edgeList.defaultInterpolate, 'the default link curve'),
  }

  // What the diagram says beyond boxes, links and groups: tooltips and the
  // accessibility texts. Read loosely — their absence is not a change of shape.
  const beyond: Loose = {}
  const tooltips = plain(database.tooltips)
  if (Array.isArray(tooltips) && tooltips.length > 0) {
    beyond.tooltips = tooltips
  }
  for (const [name, getter] of [
    ['accTitle', 'getAccTitle'],
    ['accDescription', 'getAccDescription'],
  ]) {
    const method = database[getter]
    const value = typeof method === 'function' ? (method as () => unknown).call(database) : undefined
    if (typeof value === 'string' && value !== '') {
      beyond[name] = value
    }
  }
  if (Object.keys(beyond).length > 0) {
    reading.extra = beyond
  }
  return reading
}

export type MermaidFlowReadResult =
  | { ok: true; reading: MermaidFlowReading }
  /** Mermaid parsed it, and it is another kind of diagram. */
  | { ok: false; kind: 'not-flowchart'; diagramType: string; message: string }
  /** Mermaid cannot parse it; `message` is mermaid's own. */
  | { ok: false; kind: 'rejected'; message: string }
  /** Mermaid parsed it into something this app does not know how to read. */
  | { ok: false; kind: 'unfamiliar'; message: string }

/** What a text means to mermaid, asked through the runtime's queue. Never rejects. */
export async function readMermaidFlowchart(text: string): Promise<MermaidFlowReadResult> {
  try {
    return await readMermaidDiagram(text, (diagram): MermaidFlowReadResult => {
      if (!FLOWCHART_TYPES.has(diagram.type)) {
        return {
          ok: false,
          kind: 'not-flowchart',
          diagramType: diagram.type,
          message: `This is a ${diagram.type} diagram, not a flowchart.`,
        }
      }
      return { ok: true, reading: mermaidFlowReadingFromDatabase(diagram.db) }
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return error instanceof UnfamiliarMermaidDatabase
      ? { ok: false, kind: 'unfamiliar', message }
      : { ok: false, kind: 'rejected', message }
  }
}

// ---------------------------------------------------------------------------
// Judging an edit
// ---------------------------------------------------------------------------

export type MermaidFlowElementRef =
  { kind: 'node'; id: string } | { kind: 'edge'; index: number } | { kind: 'group'; id: string }

/** What an edit says mermaid must read from the text it produced. */
export type MermaidFlowExpectation = {
  /** The whole expected reading: the reading before, with the edit applied to it. */
  reading: MermaidFlowReading
  /**
   * Elements the edit creates. They are held to every field the edit decides;
   * what mermaid carries for them beyond those (`extra`, a link's inherited
   * curve) has no "before" to be compared with.
   */
  created: MermaidFlowElementRef[]
  /**
   * Elements whose text the edit sets. Their text is compared as a person
   * would read it (`plainMermaidLabel`): mermaid keeps `Tom &amp; Jerry` for a
   * typed `Tom & Jerry`, and draws the same thing. Every other text must be
   * the very characters it was before.
   */
  relabelled: MermaidFlowElementRef[]
  /**
   * Boxes whose place in mermaid's order the edit may change — a new box, or
   * one whose first mention moves. All the others must keep their order.
   */
  reordered: string[]
}

function refKey(ref: MermaidFlowElementRef): string {
  return ref.kind === 'edge' ? `edge:${ref.index}` : `${ref.kind}:${ref.id}`
}

const asText = (value: unknown): string => JSON.stringify(plain(value) ?? null)

const sameValue = (a: unknown, b: unknown): boolean => asText(a) === asText(b)

/**
 * Every way mermaid's reading of an edited text differs from what the edit
 * said it would be, as sentences. Empty means the edit did what it was asked
 * and nothing else.
 *
 * Group members are compared as a set: the order mermaid lists them in is the
 * order of their mentions inside the group, reversed statement by statement,
 * and nothing is drawn from it.
 */
export function judgeMermaidFlowReading(expectation: MermaidFlowExpectation, actual: MermaidFlowReading): string[] {
  const expected = expectation.reading
  const created = new Set(expectation.created.map(refKey))
  const relabelled = new Set(expectation.relabelled.map(refKey))
  const reordered = new Set(expectation.reordered)
  const faults: string[] = []
  const fault = (what: string, wanted: unknown, got: unknown) => {
    faults.push(`${what}: expected ${asText(wanted)}, mermaid reads ${asText(got)}`)
  }
  const sameLabel = (key: string, wanted: string, got: string): boolean => {
    if (relabelled.has(key)) {
      return plainMermaidLabel(wanted) === plainMermaidLabel(got)
    }
    return wanted === got
  }

  if (expected.direction !== actual.direction) {
    fault('direction', expected.direction, actual.direction)
  }

  // Boxes: the same ones, the untouched ones in the same order.
  const expectedIds = expected.nodes.map((node) => node.id)
  const actualIds = actual.nodes.map((node) => node.id)
  if (!sameValue([...expectedIds].sort(), [...actualIds].sort())) {
    fault('boxes', expectedIds, actualIds)
  } else {
    const settled = (ids: string[]) => ids.filter((id) => !reordered.has(id))
    if (!sameValue(settled(expectedIds), settled(actualIds))) {
      fault('order of the boxes', settled(expectedIds), settled(actualIds))
    }
    const actualById = new Map(actual.nodes.map((node) => [node.id, node]))
    for (const wanted of expected.nodes) {
      const got = actualById.get(wanted.id) as MermaidFlowNodeReading
      const key = refKey({ kind: 'node', id: wanted.id })
      if (!sameLabel(key, wanted.text, got.text)) {
        fault(`label of ${wanted.id}`, wanted.text, got.text)
      }
      if (wanted.type !== got.type) {
        fault(`shape of ${wanted.id}`, wanted.type, got.type)
      }
      if (wanted.labelType !== got.labelType) {
        fault(`label kind of ${wanted.id}`, wanted.labelType, got.labelType)
      }
      if (!sameValue(wanted.classes, got.classes)) {
        fault(`classes of ${wanted.id}`, wanted.classes, got.classes)
      }
      if (!sameValue(wanted.styles, got.styles)) {
        fault(`styles of ${wanted.id}`, wanted.styles, got.styles)
      }
      if (!created.has(key) && !sameValue(wanted.extra ?? {}, got.extra ?? {})) {
        fault(`everything else about ${wanted.id}`, wanted.extra ?? {}, got.extra ?? {})
      }
    }
  }

  // Links: the same ones in the same order — a link's number is how a
  // `linkStyle` finds it.
  if (expected.edges.length !== actual.edges.length) {
    fault('number of links', expected.edges.length, actual.edges.length)
  } else {
    expected.edges.forEach((wanted, index) => {
      const got = actual.edges[index]
      const key = refKey({ kind: 'edge', index })
      const name = `link ${index} (${wanted.start} to ${wanted.end})`
      if (wanted.start !== got.start || wanted.end !== got.end) {
        fault(`ends of link ${index}`, [wanted.start, wanted.end], [got.start, got.end])
        return
      }
      if (wanted.type !== got.type || wanted.stroke !== got.stroke || wanted.length !== got.length) {
        fault(`line of ${name}`, [wanted.type, wanted.stroke, wanted.length], [got.type, got.stroke, got.length])
      }
      if (!sameLabel(key, wanted.text, got.text)) {
        fault(`text of ${name}`, wanted.text, got.text)
      }
      if (wanted.labelType !== got.labelType) {
        fault(`text kind of ${name}`, wanted.labelType, got.labelType)
      }
      if (wanted.id !== got.id) {
        fault(`id of ${name}`, wanted.id, got.id)
      }
      if (!sameValue(wanted.classes, got.classes)) {
        fault(`classes of ${name}`, wanted.classes, got.classes)
      }
      if (!sameValue(wanted.style ?? null, got.style ?? null)) {
        fault(`style of ${name}`, wanted.style, got.style)
      }
      if (!created.has(key)) {
        if (wanted.interpolate !== got.interpolate) {
          fault(`curve of ${name}`, wanted.interpolate, got.interpolate)
        }
        if (!sameValue(wanted.extra ?? {}, got.extra ?? {})) {
          fault(`everything else about ${name}`, wanted.extra ?? {}, got.extra ?? {})
        }
      }
    })
  }

  // Groups: the same ones, with the same boxes in them.
  const expectedGroups = expected.groups.map((group) => group.id)
  const actualGroups = actual.groups.map((group) => group.id)
  if (!sameValue([...expectedGroups].sort(), [...actualGroups].sort())) {
    fault('groups', expectedGroups, actualGroups)
  } else {
    const settled = (ids: string[]) => ids.filter((id) => !created.has(refKey({ kind: 'group', id })))
    if (!sameValue(settled(expectedGroups), settled(actualGroups))) {
      fault('order of the groups', settled(expectedGroups), settled(actualGroups))
    }
    const actualById = new Map(actual.groups.map((group) => [group.id, group]))
    for (const wanted of expected.groups) {
      const got = actualById.get(wanted.id) as MermaidFlowGroupReading
      const key = refKey({ kind: 'group', id: wanted.id })
      if (!sameValue([...wanted.nodes].sort(), [...got.nodes].sort())) {
        fault(`boxes in group ${wanted.id}`, [...wanted.nodes].sort(), [...got.nodes].sort())
      }
      if (!sameLabel(key, wanted.title, got.title)) {
        fault(`title of group ${wanted.id}`, wanted.title, got.title)
      }
      if (wanted.dir !== got.dir) {
        fault(`direction of group ${wanted.id}`, wanted.dir, got.dir)
      }
      if (wanted.labelType !== got.labelType) {
        fault(`title kind of group ${wanted.id}`, wanted.labelType, got.labelType)
      }
      if (!sameValue(wanted.classes, got.classes)) {
        fault(`classes of group ${wanted.id}`, wanted.classes, got.classes)
      }
      if (!created.has(key) && !sameValue(wanted.extra ?? {}, got.extra ?? {})) {
        fault(`everything else about group ${wanted.id}`, wanted.extra ?? {}, got.extra ?? {})
      }
    }
  }

  if (!sameValue(expected.classes, actual.classes)) {
    fault('named styles', expected.classes, actual.classes)
  }
  if (!sameValue(expected.defaultLinkStyle ?? null, actual.defaultLinkStyle ?? null)) {
    fault('default link style', expected.defaultLinkStyle, actual.defaultLinkStyle)
  }
  if (expected.defaultInterpolate !== actual.defaultInterpolate) {
    fault('default link curve', expected.defaultInterpolate, actual.defaultInterpolate)
  }
  if (!sameValue(expected.extra ?? {}, actual.extra ?? {})) {
    fault('tooltips and accessibility text', expected.extra ?? {}, actual.extra ?? {})
  }
  return faults
}

// ---------------------------------------------------------------------------
// Making an edit, under judgment
// ---------------------------------------------------------------------------

/** What an edit proposes: a new text and what it must mean, or why it will not. */
export type MermaidFlowEditPlan =
  { ok: true; text: string; expectation: MermaidFlowExpectation } | { ok: false; reason: string; line?: number }

/** An edit: given the text as read and what mermaid says it means, a plan. */
export type MermaidFlowEdit = (document: MermaidFlowDocument, reading: MermaidFlowReading) => MermaidFlowEditPlan

/**
 * Why an edit was not made:
 *   `unreadable`     mermaid cannot read the diagram as it is;
 *   `not-understood` the builder does not read it the way mermaid does;
 *   `refused`        the edit itself said no (a duplicate id, an id inside a line it cannot rewrite);
 *   `rejected`       mermaid cannot read the text the edit produced;
 *   `changed-meaning` mermaid reads the result as something other than what was asked.
 * In every one of them the diagram's text is untouched.
 */
export type MermaidFlowEditOutcome =
  | { ok: true; text: string; reading: MermaidFlowReading }
  | {
      ok: false
      stage: 'unreadable' | 'not-understood' | 'refused' | 'rejected' | 'changed-meaning'
      reason: string
      /** The line of the source the reason is about, counted from 0, when there is one. */
      line?: number
      /** The particulars, for a log or a disclosure: what differed, or mermaid's full message. */
      details: string[]
    }

export type MermaidFlowReader = (text: string) => Promise<MermaidFlowReadResult>

/** What the builder can do with a text: mermaid's reading of it, and whether it may be edited. */
export type MermaidFlowInspection =
  | { ok: true; reading: MermaidFlowReading; document: MermaidFlowDocument }
  | {
      ok: false
      stage: 'unreadable' | 'not-understood'
      reason: string
      line?: number
      details: string[]
      /** Mermaid's reading, when mermaid has one: the outline can still show the diagram read-only. */
      reading?: MermaidFlowReading
    }

const firstLine = (message: string): string => message.split('\n')[0].trim()

/**
 * Read a text both ways — by mermaid and by the builder's document — and say
 * whether the two agree. Only a text on which they agree may be edited.
 */
export async function inspectMermaidFlowchart(
  text: string,
  read: MermaidFlowReader = readMermaidFlowchart,
): Promise<MermaidFlowInspection> {
  // Mermaid is asked FIRST, and a text it rejects goes no further: the builder's
  // own reading is never enough to make a diagram editable. (It reads a few
  // texts mermaid refuses — a frontmatter or an `@{ … }` whose YAML is broken —
  // because it does not parse YAML.)
  const before = await read(text)
  if (!before.ok) {
    return { ok: false, stage: 'unreadable', reason: firstLine(before.message), details: [before.message] }
  }
  await loadMermaidFlowGrammar()
  const document = parseMermaidFlowSource(text)
  if (document.problem || !document.reading) {
    const problem = document.problem
    return {
      ok: false,
      stage: 'not-understood',
      reason: problem ? problem.message : 'The builder could not read this diagram.',
      line: problem?.line,
      details: problem ? [`${problem.kind}: ${problem.message}`] : [],
      reading: before.reading,
    }
  }
  const differences = compareMermaidFlowReadings(document.reading, before.reading)
  if (differences.length > 0) {
    return {
      ok: false,
      stage: 'not-understood',
      reason: 'The builder does not read this diagram the way mermaid does, so it will not edit it.',
      details: differences,
      reading: before.reading,
    }
  }
  return { ok: true, reading: before.reading, document }
}

/**
 * Make one edit to a diagram's text, or refuse. The text comes back changed
 * only when mermaid reads the result as exactly what the edit said it would be.
 */
export async function applyMermaidFlowEdit(
  text: string,
  edit: MermaidFlowEdit,
  read: MermaidFlowReader = readMermaidFlowchart,
): Promise<MermaidFlowEditOutcome> {
  const inspection = await inspectMermaidFlowchart(text, read)
  if (!inspection.ok) {
    return {
      ok: false,
      stage: inspection.stage,
      reason: inspection.reason,
      line: inspection.line,
      details: inspection.details,
    }
  }
  const plan = edit(inspection.document, inspection.reading)
  if (!plan.ok) {
    return { ok: false, stage: 'refused', reason: plan.reason, line: plan.line, details: [] }
  }
  if (plan.text === text) {
    return { ok: true, text, reading: inspection.reading }
  }
  const after = await read(plan.text)
  if (!after.ok) {
    return {
      ok: false,
      stage: 'rejected',
      reason: `Mermaid would not accept the result: ${firstLine(after.message)}`,
      details: [after.message],
    }
  }
  const faults = judgeMermaidFlowReading(plan.expectation, after.reading)
  if (faults.length > 0) {
    return {
      ok: false,
      stage: 'changed-meaning',
      reason: 'Mermaid would read the result as something other than what was asked, so nothing was changed.',
      details: faults,
    }
  }
  return { ok: true, text: plan.text, reading: after.reading }
}
