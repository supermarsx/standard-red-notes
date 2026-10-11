/**
 * Standard Red Notes — a syntax tokenizer for MERMAID SOURCE.
 *
 * WHY THIS EXISTS AT ALL
 *
 * The mermaid block's code pane had no highlighting of any kind: a plain
 * `<textarea>` of undifferentiated monospace text, in which an arrow, a node
 * label, a `%%` comment and a diagram keyword all look the same. The editor
 * DOES highlight fenced code blocks — `Plugins/CodeHighlightPlugin` registers
 * `@lexical/code`'s `registerCodeHighlighting`, which tokenizes through Prism —
 * but none of that is reachable here, for two independent reasons:
 *
 *   1. `registerCodeHighlighting` operates on a Lexical `CodeNode` in the
 *      editor's own node tree, splitting its children into `CodeHighlightNode`s.
 *      The mermaid block is a DecoratorNode whose source lives in a React
 *      `<textarea>`, which is not in that tree at all.
 *   2. Prism ships no mermaid grammar. There is nothing to ask it for.
 *
 * So the tokenizer is ours. It is deliberately pure — no DOM, no React, no
 * mermaid import — so that it is unit-testable and so that the pane that draws
 * it (`MermaidCodePane.tsx`) can stay a thin renderer.
 *
 *
 * WHERE THE KEYWORDS COME FROM
 *
 * Not from memory, and not from mermaid's website. Every list below was
 * harvested from the INSTALLED mermaid package (11.17.2 at the time of writing —
 * note that is NOT the 11.16.1 the package.json range `^11.16.1` names, which is
 * exactly why the lists are derived rather than typed out):
 *
 *   - DIAGRAM TYPES: the `detector` regexes in `mermaid/dist/mermaid.core.mjs`,
 *     one per registered diagram. There are 43 of them covering 37 ids; they are
 *     the authority on what the installed build will accept as a first line.
 *   - PER-DIAGRAM KEYWORDS and ARROW FORMS: the generated jison parsers, which
 *     ship inside the `sourcesContent` of `dist/chunks/mermaid.core/*.mjs.map`.
 *     Each one's lexer `rules:` array is the literal set of patterns the parser
 *     matches, so `/^(?:participant\b)/i` is proof that `participant` is a
 *     keyword and `/^(?:\s*[xo<]?--+[-xo>]\s*)/` is proof of the exact shape of
 *     a flowchart link.
 *   - THE LANGIUM DIAGRAMS (gitGraph, pie, info, packet, radar, treemap,
 *     architecture) have no jison grammar; their keywords come from the
 *     serialized langium grammar in
 *     `@mermaid-js/parser/dist/chunks/mermaid-parser.core/*.mjs`, as
 *     `{"$type":"Keyword","value":"commit"}` nodes.
 *   - FRONTMATTER, DIRECTIVES and COMMENTS: `frontMatterRegex`,
 *     `directiveRegex` and `anyCommentRegex`, read verbatim out of
 *     `dist/chunks/mermaid.core/chunk-DU6HZSFF.mjs`.
 *
 * Anything NOT derived that way is called out at its definition.
 *
 *
 * WHY THE TOKENIZER IS DIAGRAM-AWARE
 *
 * A context-free union of every diagram's keywords mis-highlights ordinary
 * words: `to`, `one`, `many` and `only one` are entity-relationship keywords,
 * and `o`, `x` and `v` are flowchart arrow heads and a direction. Applied to a
 * flowchart, that union paints node ids as keywords. So the family is detected
 * first — reusing `detectMermaidDiagramType` from MermaidGraphBuilder, which
 * already names 17 families for the visual builder — and only that family's
 * rules plus a common set are applied. `unknown` falls back to the union, which
 * is the honest answer for a source mermaid itself cannot classify.
 *
 *
 * THE CONTRACT THE RENDERER DEPENDS ON
 *
 * `tokenizeMermaid` returns tokens that are ordered, non-overlapping and
 * GAPLESS: concatenating `source.slice(token.start, token.end)` over the result
 * reproduces the input exactly, byte for byte. That is not tidiness — the pane
 * draws the tokens in a `<pre>` underlay behind a transparent `<textarea>`, so a
 * single dropped or duplicated character shifts every following glyph and the
 * caret stops sitting over its own character. `MermaidSyntax.spec.ts` asserts
 * the round-trip on every fixture, which is the cheapest possible guard on that.
 */
import { detectMermaidDiagramType } from './MermaidGraphBuilder'

/**
 * The visual classes a token can carry. Eight, not one per concept: the pane
 * maps each to one design-token colour, and a palette with more than about
 * eight hues stops reading as structure and starts reading as noise.
 */
export const MERMAID_TOKEN_TYPES = [
  'comment',
  'directive',
  'keyword',
  'property',
  'string',
  'operator',
  'punctuation',
  'number',
  'text',
] as const
export type MermaidTokenType = (typeof MERMAID_TOKEN_TYPES)[number]

/** A half-open `[start, end)` slice of the source, with its visual class. */
export interface MermaidToken {
  type: MermaidTokenType
  start: number
  end: number
}

/**
 * The diagram families this tokenizer has rules for. Everything else — and
 * every source whose first statement mermaid cannot classify — is `unknown`.
 *
 * The first 17 are exactly the keys of `MERMAID_DIAGRAM_TYPE_LABELS` in
 * MermaidGraphBuilder, so `detectMermaidDiagramType` can be reused verbatim.
 * The rest are families the installed mermaid registers that the builder's
 * detector does not name, because the builder only ever needed to answer "is
 * this a flowchart, and if not, what do I call it in a refusal".
 */
export const MERMAID_SYNTAX_FAMILIES = [
  'flowchart',
  'sequence',
  'class',
  'state',
  'er',
  'gantt',
  'pie',
  'journey',
  'gitGraph',
  'mindmap',
  'timeline',
  'quadrant',
  'requirement',
  'sankey',
  'xychart',
  'block',
  'c4',
  // Added here, not in MermaidGraphBuilder: these are registered by mermaid
  // 11.17.2 and have keywords worth colouring, but naming them would change the
  // builder's refusal messages, which are a separate contract.
  'kanban',
  'architecture',
  'packet',
  'radar',
  'treemap',
  'info',
  'venn',
  'ishikawa',
  'eventmodeling',
  'swimlane',
  'railroad',
  'cynefin',
  'unknown',
] as const
export type MermaidSyntaxFamily = (typeof MERMAID_SYNTAX_FAMILIES)[number]

/**
 * The families `detectMermaidDiagramType` does not name, as mermaid's OWN
 * detector regexes define them. Transcribed from the `.test(txt)` call sites in
 * `dist/mermaid.core.mjs`; the anchoring `^\s*` is dropped because the caller
 * has already trimmed the line.
 */
const SUPPLEMENTAL_FAMILY_DETECTORS: { family: MermaidSyntaxFamily; re: RegExp }[] = [
  { family: 'kanban', re: /^kanban\b/ },
  { family: 'architecture', re: /^architecture/ },
  { family: 'packet', re: /^packet(-beta)?/ },
  { family: 'radar', re: /^radar-beta/ },
  { family: 'treemap', re: /^(?:treemap|treeView-beta)/ },
  { family: 'info', re: /^info/ },
  { family: 'venn', re: /^venn-beta/ },
  { family: 'ishikawa', re: /^ishikawa(-beta)?\b/i },
  { family: 'eventmodeling', re: /^eventmodeling/ },
  { family: 'swimlane', re: /^swimlane-beta\b/ },
  { family: 'railroad', re: /^railroad-(?:abnf-|ebnf-|peg-)?beta/i },
  { family: 'cynefin', re: /^cynefin-beta(?:[\s:]|$)/ },
]

/**
 * Names the diagram family a source declares.
 *
 * Delegates to `detectMermaidDiagramType` first — it already skips frontmatter,
 * comments and blank lines, and it is the detector the rest of the mermaid code
 * trusts — and only when that answers `unknown` tries the supplemental
 * detectors above. The order matters: the shared detector's `flowchart` rule
 * also claims `flowchart-elk`, and its `block` rule claims `block-beta`, so
 * asking it first keeps one answer per source.
 */
export function detectMermaidSyntaxFamily(source: string): MermaidSyntaxFamily {
  if (typeof source !== 'string') {
    return 'unknown'
  }
  const shared = detectMermaidDiagramType(source)
  if (shared !== 'unknown' && (MERMAID_SYNTAX_FAMILIES as readonly string[]).includes(shared)) {
    return shared as MermaidSyntaxFamily
  }
  const statement = firstStatementOf(source)
  if (!statement) {
    return 'unknown'
  }
  const match = SUPPLEMENTAL_FAMILY_DETECTORS.find((candidate) => candidate.re.test(statement))
  return match ? match.family : 'unknown'
}

/**
 * The first line that is not frontmatter, a `%%` comment or blank — the line
 * mermaid's own detectors are run against. Mirrors the traversal in
 * `detectMermaidDiagramType` so the two never disagree about WHICH line decides.
 */
function firstStatementOf(source: string): string {
  const lines = source.split(/\r?\n/)
  let index = 0
  if (lines[0]?.trim() === '---') {
    index = 1
    while (index < lines.length && lines[index].trim() !== '---') {
      index++
    }
    index++
  }
  for (; index < lines.length; index++) {
    const trimmed = lines[index].trim()
    if (!trimmed || trimmed.startsWith('%%')) {
      continue
    }
    return trimmed
  }
  return ''
}

/**
 * Keywords every diagram understands, from the titling and interaction rules
 * that appear in all 18 jison lexers.
 *
 * `accTitle` and `accDescr` are deliberately NOT here: their lexer rules are
 * `accTitle\s*:\s*`, i.e. a key, so they are properties. See
 * ALWAYS_PROPERTY_NAMES.
 */
const COMMON_KEYWORDS = ['title', 'click', 'href', 'call', 'style', 'classDef']

/**
 * Per-family keywords, each list harvested from that diagram's own lexer rules.
 * A list holds only what the grammar matches with `\b`-anchored word patterns;
 * multi-word phrases live in MULTI_WORD_KEYWORDS below, because they cannot be
 * found by an identifier scan.
 */
const FAMILY_KEYWORDS: Record<MermaidSyntaxFamily, string[]> = {
  // flow.jison: style default linkStyle interpolate classDef class href click
  // flowchart-elk swimlane-beta graph flowchart subgraph end, the link targets,
  // and the direction tokens (LR RL TB BT TD BR and the `direction` statement).
  flowchart: [
    'graph',
    'flowchart',
    'flowchart-elk',
    'subgraph',
    'end',
    'direction',
    'class',
    'classDef',
    'style',
    'linkStyle',
    'interpolate',
    'default',
    'click',
    'href',
    'call',
    'LR',
    'RL',
    'TB',
    'BT',
    'TD',
    'BR',
    '_self',
    '_blank',
    '_parent',
    '_top',
  ],
  // sequenceDiagram.jison, every `\b` rule in its lexer.
  sequence: [
    'sequenceDiagram',
    'participant',
    'actor',
    'box',
    'create',
    'destroy',
    'as',
    'loop',
    'rect',
    'opt',
    'alt',
    'else',
    'par',
    'par_over',
    'and',
    'critical',
    'option',
    'break',
    'end',
    'links',
    'link',
    'properties',
    'details',
    'over',
    'note',
    'activate',
    'deactivate',
    'autonumber',
    'off',
  ],
  // classDiagram.jison. `<<` / `>>` annotations and `~` generics are operators,
  // not keywords, so they are not here.
  class: [
    'classDiagram',
    'classDiagram-v2',
    'class',
    'namespace',
    'classDef',
    'cssClass',
    'callback',
    'link',
    'click',
    'href',
    'call',
    'style',
    'note',
    'direction',
  ],
  // stateDiagram.jison.
  state: [
    'stateDiagram',
    'stateDiagram-v2',
    'state',
    'as',
    'note',
    'direction',
    'classDef',
    'class',
    'style',
    'click',
    'href',
    'default',
    'scale',
    'width',
  ],
  // erDiagram.jison. The single-word cardinalities only; the phrases are below.
  er: ['erDiagram', 'class', 'classDef', 'style', 'subgraph', 'end', 'one', 'many', 'to', 'PK', 'FK', 'UK'],
  // gantt.jison. Every one of these is a lexer rule of the form
  // `dateFormat\s[^#\n;]+`, i.e. a statement keyword.
  gantt: [
    'gantt',
    'dateFormat',
    'inclusiveEndDates',
    'topAxis',
    'axisFormat',
    'tickInterval',
    'includes',
    'excludes',
    'todayMarker',
    'weekday',
    'weekend',
    'section',
    'title',
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
    'sunday',
    'click',
    'href',
    'call',
  ],
  // pie is langium: only `pie` and `showData` are keywords.
  pie: ['pie', 'showData', 'title'],
  // journey.jison: `journey`, `title`, `section`.
  journey: ['journey', 'title', 'section'],
  // gitGraph is langium. `id:`/`tag:`/`type:`/`order:`/`parent:`/`msg:` are
  // properties, handled separately; these are the bare keywords.
  gitGraph: [
    'gitGraph',
    'commit',
    'branch',
    'checkout',
    'switch',
    'merge',
    'cherry-pick',
    'NORMAL',
    'REVERSE',
    'HIGHLIGHT',
    'LR',
    'TB',
    'BT',
  ],
  // mindmap.jison: only `mindmap`. Everything else is shape delimiters and text.
  mindmap: ['mindmap'],
  // timeline.jison: `timeline`, with `LR`/`TD` as its own suffix rules, plus
  // `title` and `section`.
  timeline: ['timeline', 'title', 'section', 'LR', 'TD'],
  // quadrant.jison exposes `classDef` and `title` as `\b` rules; the axis and
  // quadrant statements are matched as text runs, so they are not keywords.
  quadrant: [
    'quadrantChart',
    'title',
    'classDef',
    'x-axis',
    'y-axis',
    'quadrant-1',
    'quadrant-2',
    'quadrant-3',
    'quadrant-4',
  ],
  // requirementDiagram.jison, all 31 `\b` rules.
  requirement: [
    'requirementDiagram',
    'requirement',
    'functionalRequirement',
    'interfaceRequirement',
    'performanceRequirement',
    'physicalRequirement',
    'designConstraint',
    'element',
    'id',
    'text',
    'risk',
    'verifyMethod',
    'type',
    'docref',
    'low',
    'medium',
    'high',
    'analysis',
    'inspection',
    'demonstration',
    'test',
    'contains',
    'copies',
    'derives',
    'satisfies',
    'verifies',
    'refines',
    'traces',
    'class',
    'classDef',
    'style',
  ],
  // sankey.jison: the header only; the body is comma-separated values.
  sankey: ['sankey', 'sankey-beta'],
  // xychart.jison.
  xychart: ['xychart', 'xychart-beta', 'title', 'x-axis', 'y-axis', 'bar', 'line', 'horizontal', 'vertical'],
  // block.jison.
  block: [
    'block',
    'block-beta',
    'columns',
    'space',
    'classDef',
    'class',
    'style',
    'linkStyle',
    'default',
    'interpolate',
  ],
  // c4Diagram.jison — all 48 `\b` rules, which is the whole C4 vocabulary.
  c4: [
    'C4Context',
    'C4Container',
    'C4Component',
    'C4Dynamic',
    'C4Deployment',
    'Person',
    'Person_Ext',
    'System',
    'SystemDb',
    'SystemQueue',
    'System_Ext',
    'SystemDb_Ext',
    'SystemQueue_Ext',
    'Boundary',
    'Enterprise_Boundary',
    'System_Boundary',
    'Container_Boundary',
    'Container',
    'ContainerDb',
    'ContainerQueue',
    'Container_Ext',
    'ContainerDb_Ext',
    'ContainerQueue_Ext',
    'Component',
    'ComponentDb',
    'ComponentQueue',
    'Component_Ext',
    'ComponentDb_Ext',
    'ComponentQueue_Ext',
    'Node',
    'Node_L',
    'Node_R',
    'Deployment_Node',
    'Rel',
    'BiRel',
    'RelIndex',
    'Rel_U',
    'Rel_Up',
    'Rel_D',
    'Rel_Down',
    'Rel_L',
    'Rel_Left',
    'Rel_R',
    'Rel_Right',
    'Rel_Back',
    'UpdateElementStyle',
    'UpdateRelStyle',
    'UpdateLayoutConfig',
  ],
  // kanban.jison is mindmap's grammar with a `kanban` header.
  kanban: ['kanban'],
  // architecture is langium: group, service, junction, and the edge directions.
  architecture: ['architecture-beta', 'group', 'service', 'junction', 'in', 'L', 'R', 'T', 'B'],
  packet: ['packet', 'packet-beta', 'title'],
  radar: [
    'radar-beta',
    'axis',
    'curve',
    'graticule',
    'ticks',
    'min',
    'max',
    'showLegend',
    'circle',
    'polygon',
    'title',
  ],
  treemap: ['treemap', 'treemap-beta', 'treeView-beta', 'classDef', 'title'],
  info: ['info', 'showInfo'],
  venn: ['venn-beta', 'set', 'union', 'text', 'style', 'title'],
  ishikawa: ['ishikawa', 'ishikawa-beta', 'title'],
  eventmodeling: ['eventmodeling', 'title'],
  swimlane: [
    'swimlane-beta',
    'subgraph',
    'end',
    'direction',
    'classDef',
    'class',
    'style',
    'LR',
    'RL',
    'TB',
    'BT',
    'TD',
  ],
  railroad: ['railroad-beta', 'railroad-abnf-beta', 'railroad-ebnf-beta', 'railroad-peg-beta', 'title'],
  cynefin: ['cynefin-beta', 'title'],
  // No family detected: everything, which over-highlights but never
  // under-highlights a source that is already not rendering.
  unknown: [],
}

/**
 * Keywords mermaid's lexers match as MULTI-WORD patterns, which an identifier
 * scan can never find. Ordered longest-first inside each family, because `one
 * or more` must not be read as `one` followed by text.
 *
 * `\s+` rather than a literal space: the lexer rules use `left of\b` with a
 * single space, but a source with two spaces still parses, and highlighting is
 * not the place to be stricter than the parser.
 */
const MULTI_WORD_KEYWORDS: Partial<Record<MermaidSyntaxFamily, RegExp[]>> = {
  sequence: [/left\s+of\b/y, /right\s+of\b/y, /end\s+note\b/y],
  state: [/hide\s+empty\s+description\b/y, /left\s+of\b/y, /right\s+of\b/y, /end\s+note\b/y],
  class: [/note\s+for\b/y],
  er: [
    /one\s+or\s+zero\b/y,
    /one\s+or\s+more\b/y,
    /one\s+or\s+many\b/y,
    /zero\s+or\s+one\b/y,
    /zero\s+or\s+more\b/y,
    /zero\s+or\s+many\b/y,
    /optionally\s+to\b/y,
    /only\s+one\b/y,
    /many\(0\)/y,
    /many\(1\)/y,
  ],
}

/**
 * The accessibility directives, which every jison lexer matches as a key:
 * `accTitle\s*:\s*`, `accDescr\s*:\s*` and the multi-line `accDescr\s*\{\s*`.
 * Because of that third form they are properties whether or not a colon
 * follows, which is why they are not in COLON_PROPERTY_NAMES.
 */
const ALWAYS_PROPERTY_NAMES = new Set(['accTitle', 'accDescr', 'accDescription'])

/**
 * `name:` forms that are a property ONLY when a colon follows — langium's
 * gitGraph keys (`id:` `tag:` `type:` `order:` `parent:` `msg:`). The bare words
 * are far too common to claim unconditionally: `type` is a requirement-diagram
 * keyword and `id` is a node name in every flowchart ever written.
 */
const COLON_PROPERTY_NAMES = new Set(['id', 'tag', 'type', 'order', 'parent', 'msg'])

/**
 * Arrow, link and relation forms, as sticky regexes tried in order at each
 * position. LONGEST FIRST within a family: `<-->` must not be read as `<-` plus
 * `->`, and `-->>` must not be read as `-->` plus `>`.
 *
 * Each entry names the families it belongs to. `null` means every family,
 * including `unknown`.
 */
const OPERATOR_RULES: { families: MermaidSyntaxFamily[] | null; re: RegExp }[] = [
  // flow.jison, verbatim in shape. These five cover every flowchart link:
  //   /^(?:\s*[xo<]?--+[-xo>]\s*)/   -->  ---  --x  --o  <-->  x--x  ---->
  //   /^(?:\s*[xo<]?==+[=xo>]\s*)/   ==>  ===  ==x  ==o  <==>
  //   /^(?:\s*[xo<]?-?\.+-[xo>]?\s*)/ -.->  -.-  -..->  <-.->  -.x
  //   /^(?:\s*~~[\~]+\s*)/            ~~~  (invisible link)
  // plus the two "open" forms that start an inline-label link, `-- text -->`
  // and `== text ==>`, whose opener is `--` / `==` / `-.` with no head.
  // The surrounding `\s*` of mermaid's own rules is deliberately NOT consumed
  // here: whitespace is `text`, and swallowing it would make the operator
  // colour bleed across the gap.
  { families: ['flowchart', 'swimlane', 'block', 'unknown'], re: /[xo<]?-?\.+-[xo>]?/y },
  { families: ['flowchart', 'swimlane', 'block', 'unknown'], re: /[xo<]?==+[=xo>]/y },
  { families: ['flowchart', 'swimlane', 'block', 'unknown'], re: /[xo<]?--+[-xo>]/y },
  { families: ['flowchart', 'swimlane', 'block', 'unknown'], re: /~~~+/y },
  { families: ['flowchart', 'swimlane', 'block', 'unknown'], re: /[xo<]?-\./y },
  { families: ['flowchart', 'swimlane', 'block', 'unknown'], re: /[xo<]?==/y },
  { families: ['flowchart', 'swimlane', 'block', 'unknown'], re: /[xo<]?--/y },

  // sequenceDiagram.jison's arrow literals, longest first. The stick-arrow
  // forms (`--|\`, `//--`, …) are the top/bottom variants added in mermaid 11.
  { families: ['sequence', 'unknown'], re: /<<-->>/y },
  { families: ['sequence', 'unknown'], re: /<<->>/y },
  { families: ['sequence', 'unknown'], re: /-->>/y },
  { families: ['sequence', 'unknown'], re: /->>/y },
  { families: ['sequence', 'unknown'], re: /--\|[\\/]/y },
  { families: ['sequence', 'unknown'], re: /--(?:\\\\|\/\/)/y },
  { families: ['sequence', 'unknown'], re: /[\\/]\|--/y },
  { families: ['sequence', 'unknown'], re: /(?:\/\/|\\\\)--/y },
  { families: ['sequence', 'unknown'], re: /-\|[\\/]/y },
  { families: ['sequence', 'unknown'], re: /-(?:\\\\|\/\/)/y },
  { families: ['sequence', 'unknown'], re: /[\\/]\|-/y },
  { families: ['sequence', 'unknown'], re: /(?:\/\/|\\\\)-/y },
  { families: ['sequence', 'unknown'], re: /--[x)]/y },
  { families: ['sequence', 'unknown'], re: /-->/y },
  { families: ['sequence', 'unknown'], re: /-[x)]/y },
  { families: ['sequence', 'unknown'], re: /->/y },

  // classDiagram.jison assembles a relation from `<|` `|>` `>` `<` `*` `o` `()`
  // around `--` or `..`, so the whole relation is matched as one token where it
  // can be and as its pieces where it cannot.
  { families: ['class', 'unknown'], re: /(?:<\||\*|o|<)?(?:--|\.\.)(?:\|>|\*|o|>)?/y },
  { families: ['class', 'unknown'], re: /<<|>>/y },

  // erDiagram.jison's cardinality symbols plus its four relation bodies.
  // Gated to `er` because `|o` and `}o` would otherwise claim the contents of a
  // flowchart edge label such as `|o|`.
  { families: ['er'], re: /[|}o][|{o]\s*(?:--|\.\.|\.-|-\.)\s*[|}o][|{o]/y },
  { families: ['er'], re: /[|}o][|{o]/y },
  { families: ['er'], re: /--|\.\.|\.-|-\./y },

  // stateDiagram.jison: `-->` and `--`, and `[*]` as the start/end pseudostate.
  { families: ['state', 'unknown'], re: /-->|--/y },
  { families: ['state', 'class', 'unknown'], re: /\[\*\]/y },
  { families: ['state', 'unknown'], re: /<<(?:fork|join|choice)>>/y },

  // mindmap/kanban node shapes are delimiters, but `::icon(` and `:::` are the
  // decorators, and both read better as operators than as punctuation.
  { families: ['mindmap', 'kanban', 'unknown'], re: /::icon\(/y },

  // `:::` is the shorthand class assignment in flowchart, class, er, mindmap and
  // kanban — the same three characters in every one of their lexers.
  { families: null, re: /:::/y },

  // architecture's edge arrows, e.g. `service a (L)--(R) service b`.
  { families: ['architecture'], re: /\((?:L|R|T|B)\)--\((?:L|R|T|B)\)/y },
]

/**
 * The frontmatter block, mirroring mermaid's own
 * `frontMatterRegex = /^([^\S\n\r]*)-{3}\s*[\n\r](.*?)[\n\r]\1-{3}\s*[\n\r]+/s`.
 * Anchored, non-global and non-sticky: it is only ever tried at offset 0.
 */
const FRONTMATTER_RE = /^([^\S\n\r]*)-{3}[^\S\n\r]*\r?\n([\s\S]*?)\r?\n\1-{3}[^\S\n\r]*(?=\r?\n|$)/

/** A `key:` at the start of a frontmatter line. */
const YAML_KEY_RE = /^([^\S\n]*)([A-Za-z_][\w-]*)(\s*:)/

/** An identifier, WITHOUT `-`. See `extendHyphenatedKeyword` for why. */
const IDENTIFIER_RE = /[A-Za-z_À-￿][\wÀ-￿]*/y

/** gantt's own date rule, `\d\d\d\d-\d\d-\d\d\b`, then plain numbers. */
const DATE_RE = /\d{4}-\d{2}-\d{2}\b/y
const NUMBER_RE = /\d+(?:\.\d+)?%?/y

/**
 * The characters that can START an arrow, link or relation, from the rules
 * above. A FAST PATH, and a load-bearing one: without it the ~20 sticky
 * operator regexes are tried at every position in the source, including every
 * letter of every label, which measured 3.2ms per pass over a 600-line / 15.7KB
 * diagram in headless Chrome. Gating on the first character took the same pass
 * to well under a millisecond, and a keystroke has to fit inside a 16.7ms frame
 * along with React's work.
 *
 * `x` and `o` are here because flowchart arrow heads can lead (`x--x`, `o--o`),
 * but they are additionally required to be followed by `-`, `=` or `.` — see
 * `canStartOperator` — so the `o` in `node` does not pay for the lookup.
 */
const OPERATOR_LEAD = new Set(['-', '=', '.', '<', '>', '~', '|', ':', '/', '\\', '*', '{', '}', '(', '[', 'x', 'o'])

/** What may follow a leading `x`/`o` for it to still be an arrow head. */
const OPERATOR_AFTER_HEAD = new Set(['-', '=', '.', '|', '{'])

function canStartOperator(source: string, index: number): boolean {
  const char = source[index]
  if (!OPERATOR_LEAD.has(char)) {
    return false
  }
  // `x` and `o` are the only LETTERS in the set — flowchart's leading arrow
  // heads (`x--x`, `o--o`) and entity-relationship's right-hand cardinalities
  // (`o|`, `o{`). Requiring one of the five continuation characters is what
  // keeps the `o` in every `node` off this path.
  if (char === 'x' || char === 'o') {
    return OPERATOR_AFTER_HEAD.has(source[index + 1])
  }
  return true
}

/** Shape delimiters and separators, longest first. */
const PUNCTUATION = [
  '(((',
  ')))',
  '[[',
  ']]',
  '((',
  '))',
  '{{',
  '}}',
  '([',
  '])',
  '[(',
  ')]',
  '[/',
  '[\\',
  '/]',
  '\\]',
  '[|',
  '(-',
  '-)',
  '@{',
  '[',
  ']',
  '(',
  ')',
  '{',
  '}',
  '>',
  '<',
  ':',
  ';',
  ',',
  '&',
  '+',
  '#',
  '~',
  '^',
]

/**
 * Tokenize mermaid source.
 *
 * Single pass, O(length): at every position the rules below are tried in a fixed
 * order and the first match wins. Nothing backtracks over an already-emitted
 * token, and an unmatched character is emitted as `text`, so the walk always
 * advances and the result is always gapless.
 */
export function tokenizeMermaid(source: string, familyOverride?: MermaidSyntaxFamily): MermaidToken[] {
  if (typeof source !== 'string' || source.length === 0) {
    return []
  }
  const family = familyOverride ?? detectMermaidSyntaxFamily(source)
  const keywords = keywordSetFor(family)
  const multiWord = MULTI_WORD_KEYWORDS[family] ?? (family === 'unknown' ? allMultiWordRules() : EMPTY_RULES)
  const operators = operatorRulesFor(family)

  const tokens: MermaidToken[] = []
  // `text` runs are coalesced: `push` only closes the pending run when a
  // classified token starts, so a 400-character label is one token and not 400.
  let pendingTextStart = -1

  const flushText = (end: number): void => {
    if (pendingTextStart >= 0 && end > pendingTextStart) {
      tokens.push({ type: 'text', start: pendingTextStart, end })
    }
    pendingTextStart = -1
  }
  const emit = (type: MermaidTokenType, start: number, end: number): void => {
    flushText(start)
    tokens.push({ type, start, end })
  }

  let index = 0

  // Frontmatter, if any, is consumed whole before the scan proper: its `---`
  // fences and `key:` lines are YAML, not mermaid, and running the mermaid rules
  // over them would paint `---` as a flowchart link.
  const frontmatter = FRONTMATTER_RE.exec(source)
  if (frontmatter) {
    index = tokenizeFrontmatter(source, frontmatter[0].length, tokens)
  }

  while (index < source.length) {
    const char = source[index]

    // 1. A `%%{init: ...}%%` directive, before the `%%` comment rule: a comment
    //    is `%%` NOT followed by `{`, which is mermaid's own
    //    `anyCommentRegex` / `directiveRegex` split.
    if (char === '%' && source.startsWith('%%{', index)) {
      const close = source.indexOf('}%%', index + 3)
      const end = close === -1 ? endOfLine(source, index) : close + 3
      emit('directive', index, end)
      index = end
      continue
    }

    // 2. A `%%` comment, to end of line.
    if (char === '%' && source.startsWith('%%', index)) {
      const end = endOfLine(source, index)
      emit('comment', index, end)
      index = end
      continue
    }

    // 3. A double-quoted string. Unterminated strings stop at the newline rather
    //    than swallowing the rest of the file, so one stray quote discolours one
    //    line instead of the whole diagram.
    if (char === '"') {
      const end = closingDelimiter(source, index, '"')
      emit('string', index, end)
      index = end
      continue
    }

    // 4. A backtick-delimited string — class diagram's quoted member names and
    //    the inner half of a markdown string, `["`bold`"]`.
    if (char === '`') {
      const end = closingDelimiter(source, index, '`')
      emit('string', index, end)
      index = end
      continue
    }

    // 5. An arrow / link / relation. Gated on the first character: see
    //    OPERATOR_LEAD for why that gate is the difference between a pass that
    //    fits in a frame and one that does not.
    if (canStartOperator(source, index)) {
      const operatorEnd = matchFirst(operators, source, index)
      if (operatorEnd > index) {
        emit('operator', index, operatorEnd)
        index = operatorEnd
        continue
      }
    }

    // 6. A `|…|` edge label. Checked AFTER the operators so that er's `||--o{`
    //    and class's `|>` keep their own colour.
    if (char === '|') {
      const close = source.indexOf('|', index + 1)
      const lineEnd = endOfLine(source, index)
      if (close !== -1 && close < lineEnd) {
        emit('punctuation', index, index + 1)
        if (close > index + 1) {
          tokens.push({ type: 'string', start: index + 1, end: close })
        }
        tokens.push({ type: 'punctuation', start: close, end: close + 1 })
        index = close + 1
        continue
      }
      emit('punctuation', index, index + 1)
      index += 1
      continue
    }

    // 7. A date, then a number. gantt's `\d\d\d\d-\d\d-\d\d\b` first, so a date
    //    is one token rather than three numbers and two arrows.
    const dateEnd = matchSticky(DATE_RE, source, index)
    if (dateEnd > index) {
      emit('number', index, dateEnd)
      index = dateEnd
      continue
    }
    if (char >= '0' && char <= '9') {
      const numberEnd = matchSticky(NUMBER_RE, source, index)
      if (numberEnd > index) {
        emit('number', index, numberEnd)
        index = numberEnd
        continue
      }
    }

    // 8. A multi-word keyword, before the identifier scan that would split it.
    const phraseEnd = matchFirstRegex(multiWord, source, index)
    if (phraseEnd > index) {
      emit('keyword', index, phraseEnd)
      index = phraseEnd
      continue
    }

    // 9. An identifier: a keyword, a `name:` property, or plain text.
    const wordEnd = matchSticky(IDENTIFIER_RE, source, index)
    if (wordEnd > index) {
      const extended = extendHyphenatedKeyword(source, index, wordEnd, keywords)
      const word = source.slice(index, extended)
      if (keywords.has(word)) {
        emit('keyword', index, extended)
        index = extended
        continue
      }
      if (ALWAYS_PROPERTY_NAMES.has(word) || (COLON_PROPERTY_NAMES.has(word) && isFollowedByColon(source, extended))) {
        emit('property', index, extended)
        index = extended
        continue
      }
      if (pendingTextStart < 0) {
        pendingTextStart = index
      }
      index = extended
      continue
    }

    // 10. Punctuation.
    const punctuation = PUNCTUATION.find((candidate) => source.startsWith(candidate, index))
    if (punctuation) {
      emit('punctuation', index, index + punctuation.length)
      index += punctuation.length
      continue
    }

    // 11. Anything else — whitespace, a lone `-`, a label character — is text.
    if (pendingTextStart < 0) {
      pendingTextStart = index
    }
    index += 1
  }
  flushText(source.length)
  return tokens
}

/**
 * Tokenize the YAML frontmatter block as `---` fences plus `key: value` lines.
 * Returns the offset the mermaid scan should start at.
 *
 * Deliberately shallow: this is a highlighter, not a YAML parser, and mermaid
 * itself only reads a handful of keys (`title`, `config`, `displayMode`).
 */
function tokenizeFrontmatter(source: string, blockEnd: number, tokens: MermaidToken[]): number {
  let index = 0
  while (index < blockEnd) {
    const lineEnd = endOfLine(source, index)
    const line = source.slice(index, lineEnd)
    if (line.trim() === '---') {
      tokens.push({ type: 'punctuation', start: index, end: lineEnd })
    } else {
      const key = YAML_KEY_RE.exec(line)
      if (key) {
        const indent = key[1].length
        if (indent > 0) {
          tokens.push({ type: 'text', start: index, end: index + indent })
        }
        tokens.push({ type: 'property', start: index + indent, end: index + indent + key[2].length })
        tokens.push({
          type: 'punctuation',
          start: index + indent + key[2].length,
          end: index + key[0].length,
        })
        if (lineEnd > index + key[0].length) {
          tokens.push({ type: 'text', start: index + key[0].length, end: lineEnd })
        }
      } else if (lineEnd > index) {
        tokens.push({ type: 'text', start: index, end: lineEnd })
      }
    }
    // The newline itself, so the token stream stays gapless.
    const next = skipNewline(source, lineEnd)
    if (next > lineEnd) {
      tokens.push({ type: 'text', start: lineEnd, end: next })
    }
    if (next <= index) {
      break
    }
    index = next
  }
  return index
}

/**
 * The keyword set per family, built once and cached. Rebuilding it on every
 * tokenisation allocated 40-odd strings into a fresh Set per keystroke, which
 * is pure waste on a path that has to fit inside a frame.
 */
const keywordSetCache = new Map<MermaidSyntaxFamily, Set<string>>()

function keywordSetFor(family: MermaidSyntaxFamily): Set<string> {
  const cached = keywordSetCache.get(family)
  if (cached) {
    return cached
  }
  let built: Set<string>
  if (family === 'unknown') {
    built = new Set(COMMON_KEYWORDS)
    for (const list of Object.values(FAMILY_KEYWORDS)) {
      for (const keyword of list) {
        built.add(keyword)
      }
    }
    // `to`, `one` and `many` are entity-relationship keywords and ordinary
    // English. In a source nothing could classify they do more harm than good.
    for (const ambiguous of ['to', 'one', 'many', 'text', 'type', 'id', 'in', 'set', 'line', 'bar', 'min', 'max']) {
      built.delete(ambiguous)
    }
  } else {
    built = new Set([...COMMON_KEYWORDS, ...FAMILY_KEYWORDS[family]])
  }
  keywordSetCache.set(family, built)
  return built
}

/** Likewise for the per-family operator rule list. */
const operatorRuleCache = new Map<MermaidSyntaxFamily, RegExp[]>()

function operatorRulesFor(family: MermaidSyntaxFamily): RegExp[] {
  const cached = operatorRuleCache.get(family)
  if (cached) {
    return cached
  }
  const built = OPERATOR_RULES.filter((rule) => rule.families === null || rule.families.includes(family)).map(
    (rule) => rule.re,
  )
  operatorRuleCache.set(family, built)
  return built
}

/** Shared empty list, so the hot path never allocates one. */
const EMPTY_RULES: RegExp[] = []

let unionMultiWord: RegExp[] | null = null

function allMultiWordRules(): RegExp[] {
  if (!unionMultiWord) {
    unionMultiWord = Object.values(MULTI_WORD_KEYWORDS).flatMap((rules) => rules ?? [])
  }
  return unionMultiWord
}

/**
 * Keywords with a hyphen in them — `stateDiagram-v2`, `flowchart-elk`,
 * `cherry-pick`, `x-axis`, `packet-beta` — cannot come out of an identifier scan
 * that treats `-` as a word character, because then `A-->B` scans as the single
 * identifier `A--`. So the scan stops at the hyphen and this extends the match
 * only when the LONGER form is itself a known keyword. `graph-->b` therefore
 * stays `graph` + an arrow, while `flowchart-elk` becomes one keyword.
 */
function extendHyphenatedKeyword(source: string, start: number, end: number, keywords: Set<string>): number {
  let cursor = end
  let best = end
  while (source[cursor] === '-') {
    const tail = matchSticky(IDENTIFIER_RE, source, cursor + 1)
    if (tail <= cursor + 1) {
      break
    }
    cursor = tail
    if (keywords.has(source.slice(start, cursor))) {
      best = cursor
    }
  }
  return best
}

/** Whether the next non-space character is a `:`, for `tag: v1` style keys. */
function isFollowedByColon(source: string, index: number): boolean {
  let cursor = index
  while (source[cursor] === ' ' || source[cursor] === '\t') {
    cursor++
  }
  return source[cursor] === ':'
}

/** The offset of the `\n` or `\r` that ends this line, or the source length. */
function endOfLine(source: string, index: number): number {
  const newline = source.indexOf('\n', index)
  if (newline === -1) {
    return source.length
  }
  return source[newline - 1] === '\r' ? newline - 1 : newline
}

function skipNewline(source: string, index: number): number {
  if (source[index] === '\r' && source[index + 1] === '\n') {
    return index + 2
  }
  if (source[index] === '\n' || source[index] === '\r') {
    return index + 1
  }
  return index
}

/**
 * The end of a delimited run starting at `index`, or the end of the line when
 * the closing delimiter never arrives.
 */
function closingDelimiter(source: string, index: number, delimiter: string): number {
  const close = source.indexOf(delimiter, index + 1)
  const lineEnd = endOfLine(source, index)
  if (close === -1 || close >= lineEnd) {
    return lineEnd
  }
  return close + 1
}

function matchSticky(re: RegExp, source: string, index: number): number {
  re.lastIndex = index
  const match = re.exec(source)
  return match && match.index === index ? index + match[0].length : index
}

function matchFirstRegex(rules: RegExp[], source: string, index: number): number {
  for (const re of rules) {
    const end = matchSticky(re, source, index)
    if (end > index) {
      return end
    }
  }
  return index
}

const matchFirst = matchFirstRegex

/**
 * The CSS class a token type is drawn with. One place, so the pane and its
 * specs cannot disagree, and so an unmapped type is a compile error rather than
 * an unstyled span.
 *
 * `text` gets no class at all: it inherits the pane's own colour, which is the
 * editor foreground, which is what unclassified source should look like.
 */
export const MERMAID_TOKEN_CLASS: Record<MermaidTokenType, string> = {
  comment: 'MermaidCode__comment',
  directive: 'MermaidCode__directive',
  keyword: 'MermaidCode__keyword',
  property: 'MermaidCode__property',
  string: 'MermaidCode__string',
  operator: 'MermaidCode__operator',
  punctuation: 'MermaidCode__punctuation',
  number: 'MermaidCode__number',
  text: '',
}

/**
 * The tokens of one line, as the pane needs them: offsets rebased to the line
 * so each line can be rendered — and memoised — independently of the lines
 * above it.
 *
 * Splitting AFTER tokenizing, rather than tokenizing line by line, is what lets
 * a `%%{init: …}%%` directive or a frontmatter block span lines.
 */
export interface MermaidTokenizedLine {
  text: string
  tokens: MermaidToken[]
}

export function tokenizeMermaidByLine(source: string, familyOverride?: MermaidSyntaxFamily): MermaidTokenizedLine[] {
  const text = typeof source === 'string' ? source : ''
  const tokens = tokenizeMermaid(text, familyOverride)
  const lines: MermaidTokenizedLine[] = []
  let lineStart = 0
  let tokenIndex = 0

  // One pass over the lines and one cursor into the token list: a token that
  // straddles a line break is split at the break, which keeps every line's
  // tokens gapless over its own text.
  while (lineStart <= text.length) {
    const newline = text.indexOf('\n', lineStart)
    const lineEnd = newline === -1 ? text.length : newline
    const lineTokens: MermaidToken[] = []
    while (tokenIndex < tokens.length && tokens[tokenIndex].start < lineEnd) {
      const token = tokens[tokenIndex]
      const start = Math.max(token.start, lineStart)
      const end = Math.min(token.end, lineEnd)
      if (end > start) {
        lineTokens.push({ type: token.type, start: start - lineStart, end: end - lineStart })
      }
      if (token.end > lineEnd) {
        break
      }
      tokenIndex++
    }
    lines.push({ text: text.slice(lineStart, lineEnd), tokens: lineTokens })
    if (newline === -1) {
      break
    }
    lineStart = newline + 1
  }
  return lines
}
