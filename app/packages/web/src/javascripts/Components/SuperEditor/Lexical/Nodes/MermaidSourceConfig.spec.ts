/**
 * The one module that edits a diagram's text on behalf of a control.
 *
 * What these tests pin is the contract in MermaidSourceConfig.ts's header: a
 * patch touches frontmatter lines and no others; what it writes can be taken
 * away again to the byte; and a frontmatter it cannot keep exactly is refused
 * by name instead of rewritten. What a text MEANS to mermaid is not asserted
 * here — jest cannot load the library — but in scripts/MermaidConfigContract.mjs,
 * which MermaidConfigContract.spec.ts runs inside this same gate.
 */
import {
  describeUnreadableFrontmatter,
  emitMermaidConfigScalar,
  listMermaidFrontmatterConfig,
  MermaidConfigChange,
  MermaidConfigRefusalCode,
  patchMermaidSourceConfig,
  readMermaidConfigValue,
  readMermaidSourceConfig,
} from './MermaidSourceConfig'

const FLOW = 'flowchart LR\n  A[Alpha] -->|feeds| B[Beta]\n  B --> C'

const fm = (yaml: string, body = FLOW) => `---\n${yaml}\n---\n${body}`

const patched = (text: string, changes: MermaidConfigChange[]): string => {
  const result = patchMermaidSourceConfig(text, changes)
  if (!result.ok) {
    throw new Error(`refused (${result.refusal.code}): ${result.refusal.message}`)
  }
  return result.text
}

const refusalOf = (text: string, changes: MermaidConfigChange[]) => {
  const result = patchMermaidSourceConfig(text, changes)
  if (result.ok) {
    throw new Error(`not refused; wrote ${JSON.stringify(result.text)}`)
  }
  return result.refusal
}

const valueOf = (text: string, ...path: string[]) => readMermaidConfigValue(readMermaidSourceConfig(text), path)

const set = (key: string, value: string | number | boolean): MermaidConfigChange => ({ path: key.split('.'), value })
const unset = (key: string): MermaidConfigChange => ({ path: key.split('.'), value: undefined })

/** Lines WITH their terminators, so a changed line ending is a changed line. */
const linesOf = (text: string): string[] => text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? []

/**
 * A line diff by longest common subsequence: which lines of `before` are gone
 * and which lines of `after` are new. Small on purpose — it is the instrument
 * the "only frontmatter lines" claim is measured with, so it must be obviously
 * right rather than fast.
 */
const lineDiff = (before: string, after: string): { removed: number[]; added: number[] } => {
  const a = linesOf(before)
  const b = linesOf(after)
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const removed: number[] = []
  const added: number[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      removed.push(i++)
    } else {
      added.push(j++)
    }
  }
  while (i < a.length) {
    removed.push(i++)
  }
  while (j < b.length) {
    added.push(j++)
  }
  return { removed, added }
}

/**
 * The line indexes a text's frontmatter occupies, fences included — found
 * WITHOUT the module under test, so the proof does not lean on what it proves.
 */
const frontmatterSpan = (text: string): { first: number; last: number } | null => {
  const lines = linesOf(text).map((line) => line.replace(/[\r\n]+$/, ''))
  const first = lines.findIndex((line) => line.trim() !== '')
  if (first === -1 || lines[first].trim() !== '---') {
    return null
  }
  const last = lines.findIndex((line, index) => index > first && /^---\s*$/.test(line))
  return last === -1 ? null : { first, last }
}

describe('reading what a diagram sets for itself', () => {
  it('finds nothing in a diagram with no frontmatter and no directive', () => {
    const reading = readMermaidSourceConfig(FLOW)
    expect(reading.frontmatter.state).toBe('absent')
    expect(reading.directive.state).toBe('absent')
    expect(valueOf(FLOW, 'theme')).toEqual({ state: 'unset' })
    expect(listMermaidFrontmatterConfig(reading)).toEqual([])
  })

  it('does not take a link of three hyphens for a frontmatter', () => {
    expect(readMermaidSourceConfig('graph TD\n  A --- B').frontmatter.state).toBe('absent')
  })

  it('reads a value with the line it is on, counted in the diagram’s text', () => {
    const text = fm('title: Plan\nconfig:\n  theme: forest\n  flowchart:\n    curve: linear\n    nodeSpacing: 30')
    expect(valueOf(text, 'theme')).toEqual({ state: 'set', value: 'forest', from: 'frontmatter', line: 4 })
    expect(valueOf(text, 'flowchart', 'curve')).toEqual({ state: 'set', value: 'linear', from: 'frontmatter', line: 6 })
    expect(valueOf(text, 'flowchart', 'nodeSpacing')).toEqual({ state: 'set', value: 30, from: 'frontmatter', line: 7 })
    expect(valueOf(text, 'look')).toEqual({ state: 'unset' })
    expect(valueOf(text, 'sequence', 'actorMargin')).toEqual({ state: 'unset' })
  })

  it('reads each way of writing a value: bare, double-quoted, single-quoted, number, boolean', () => {
    const text = fm(
      [
        'config:',
        '  theme: neo-dark',
        '  look: "handDrawn"',
        "  layout: 'it''s'",
        '  handDrawnSeed: -7',
        '  fontSize: 12.5',
        '  markdownAutoWrap: false',
        '  themeVariables:',
        '    fontSize: 20px',
      ].join('\n'),
    )
    expect(listMermaidFrontmatterConfig(readMermaidSourceConfig(text)).map(({ key, value }) => [key, value])).toEqual([
      ['theme', 'neo-dark'],
      ['look', 'handDrawn'],
      ['layout', "it's"],
      ['handDrawnSeed', -7],
      ['fontSize', 12.5],
      ['markdownAutoWrap', false],
      ['themeVariables.fontSize', '20px'],
    ])
  })

  it('treats a key with nothing after it, and a null, as not set — mermaid drops both', () => {
    const text = fm('config:\n  theme:\n  look: null\n  layout: ~')
    expect(valueOf(text, 'theme')).toEqual({ state: 'unset' })
    expect(valueOf(text, 'look')).toEqual({ state: 'unset' })
    expect(valueOf(text, 'layout')).toEqual({ state: 'unset' })
  })

  it('reads through blank lines before the frontmatter, as the app trims them away', () => {
    expect(valueOf(`\n\n${fm('config:\n  theme: forest')}`, 'theme')).toMatchObject({
      state: 'set',
      value: 'forest',
      line: 5,
    })
  })

  it('reads Windows line endings', () => {
    expect(valueOf(fm('config:\n  theme: forest').split('\n').join('\r\n'), 'theme')).toMatchObject({ value: 'forest' })
  })

  describe('init directives', () => {
    it('lets a directive win over the frontmatter, and says which line it is on', () => {
      const text = fm('config:\n  theme: dark\n  look: handDrawn', `%%{init: {"theme":"forest"}}%%\n${FLOW}`)
      expect(valueOf(text, 'theme')).toEqual({ state: 'set', value: 'forest', from: 'directive', line: 6 })
      // A key the directive does not name is still the frontmatter's.
      expect(valueOf(text, 'look')).toEqual({ state: 'set', value: 'handDrawn', from: 'frontmatter', line: 4 })
    })

    it('reads a directive written with single quotes, as mermaid does', () => {
      expect(valueOf(`%%{init: {'flowchart':{'curve':'step'}}}%%\n${FLOW}`, 'flowchart', 'curve')).toMatchObject({
        value: 'step',
        from: 'directive',
        line: 1,
      })
    })

    it('lets the later of two directives win', () => {
      const text = `%%{init: {"theme":"forest"}}%%\n%%{init: {"theme":"dark"}}%%\n${FLOW}`
      expect(valueOf(text, 'theme')).toMatchObject({ value: 'dark', from: 'directive' })
    })

    it('finds a directive wherever it is in the text', () => {
      expect(valueOf(`${FLOW}\n%%{init: {"theme":"forest"}}%%`, 'theme')).toMatchObject({ value: 'forest', line: 4 })
    })

    it('drops every directive when one of them is not JSON, as mermaid does', () => {
      const text = `%%{init: {"theme":"dark"}}%%\n%%{init: {theme: forest}}%%\n${FLOW}`
      expect(readMermaidSourceConfig(text).directive.state).toBe('absent')
      expect(valueOf(text, 'theme')).toEqual({ state: 'unset' })
    })

    it('says a key is unset when a directive nulls what the frontmatter sets', () => {
      expect(valueOf(fm('config:\n  theme: dark', `%%{init: {"theme":null}}%%\n${FLOW}`), 'theme')).toEqual({
        state: 'unset',
      })
    })

    it('will not answer for a directive mermaid applies by diagram type', () => {
      const reading = valueOf(`%%{init: {"config":{"curve":"step"}}}%%\n${FLOW}`, 'theme')
      expect(reading.state).toBe('unknown')
    })
  })

  it('will not report a theme variable mermaid itself throws away', () => {
    const text = fm('config:\n  themeVariables:\n    fontSize: "calc(1px + 2px)"\n    primaryColor: "#ffcc00"')
    expect(valueOf(text, 'themeVariables', 'fontSize').state).toBe('unknown')
    expect(valueOf(text, 'themeVariables', 'primaryColor')).toMatchObject({ state: 'set', value: '#ffcc00' })
  })
})

/**
 * EVERY shape the reader refuses, with the name it refuses it by and the line
 * it points at. The same table drives the reading test (the value is `unknown`,
 * never a guess) and the writing test (nothing is written).
 */
const UNSUPPORTED: { shape: string; text: string; code: MermaidConfigRefusalCode; line: number; says: string }[] = [
  {
    shape: 'a YAML comment on its own line',
    text: fm('# mine\nconfig:\n  theme: forest'),
    code: 'yaml-comment',
    line: 2,
    says: 'a YAML comment',
  },
  {
    shape: 'a YAML comment after a value',
    text: fm('config:\n  theme: forest # mine'),
    code: 'yaml-comment',
    line: 3,
    says: 'a YAML comment',
  },
  {
    shape: 'a YAML comment after a quoted value',
    text: fm('config:\n  theme: "forest" # mine'),
    code: 'yaml-comment',
    line: 3,
    says: 'a YAML comment',
  },
  {
    shape: 'a YAML comment where a value would be',
    text: fm('config: # options\n  theme: forest'),
    code: 'yaml-comment',
    line: 2,
    says: 'a YAML comment',
  },
  { shape: 'an anchor', text: fm('config:\n  theme: &t forest'), code: 'yaml-anchor', line: 3, says: 'a YAML anchor' },
  {
    shape: 'an alias',
    text: fm('config:\n  theme: forest\n  look: *t'),
    code: 'yaml-alias',
    line: 4,
    says: 'a YAML alias',
  },
  { shape: 'a tag', text: fm('config:\n  theme: !!str forest'), code: 'yaml-tag', line: 3, says: 'a YAML tag' },
  {
    shape: 'a flow mapping',
    text: fm('config: { theme: forest }'),
    code: 'yaml-flow-collection',
    line: 2,
    says: 'in braces or brackets',
  },
  {
    shape: 'a flow sequence',
    text: fm('config:\n  secure: [theme]'),
    code: 'yaml-flow-collection',
    line: 3,
    says: 'in braces or brackets',
  },
  {
    shape: 'a block sequence',
    text: fm('config:\n  secure:\n    - theme'),
    code: 'yaml-sequence',
    line: 4,
    says: 'a YAML list',
  },
  {
    shape: 'a literal block scalar',
    text: fm('title: |\n  Plan\nconfig:\n  theme: forest'),
    code: 'yaml-multi-line-scalar',
    line: 2,
    says: 'over several lines',
  },
  {
    shape: 'a folded block scalar',
    text: fm('title: >\n  Plan\nconfig:\n  theme: forest'),
    code: 'yaml-multi-line-scalar',
    line: 2,
    says: 'over several lines',
  },
  {
    shape: 'a plain value continued on the next line',
    text: fm('title: Plan\n  continued\nconfig:\n  theme: forest'),
    code: 'yaml-multi-line-scalar',
    line: 2,
    says: 'over several lines',
  },
  {
    shape: 'a quoted value continued on the next line',
    text: fm('title: "Plan\n  continued"\nconfig:\n  theme: forest'),
    code: 'yaml-multi-line-scalar',
    line: 2,
    says: 'does not end on its own line',
  },
  {
    shape: 'a top-level key mermaid does not define',
    text: fm('author: me\nconfig:\n  theme: forest'),
    code: 'unknown-top-level-key',
    line: 2,
    says: '"author"',
  },
  {
    shape: 'a quoted key',
    text: fm('"config":\n  theme: forest'),
    code: 'yaml-quoted-key',
    line: 2,
    says: 'a key written in quotes',
  },
  {
    shape: 'a complex key',
    text: fm('? config\n: theme'),
    code: 'yaml-complex-key',
    line: 2,
    says: 'a YAML complex key',
  },
  {
    shape: 'a second YAML document',
    text: fm('config:\n  theme: forest\n...\ntitle: x'),
    code: 'yaml-document-marker',
    line: 4,
    says: 'a second YAML document',
  },
  {
    shape: 'a tab for indentation',
    text: fm('config:\n\ttheme: forest'),
    code: 'yaml-tab-indentation',
    line: 3,
    says: 'indented with a tab',
  },
  {
    shape: 'indentation that does not line up',
    text: fm('config:\n    look: classic\n  theme: forest'),
    code: 'yaml-indentation',
    line: 4,
    says: 'indentation',
  },
  {
    shape: 'a duplicate key',
    text: fm('config:\n  theme: forest\n  theme: dark'),
    code: 'yaml-duplicate-key',
    line: 4,
    says: '"theme" twice',
  },
  {
    shape: 'a line that is not key: value',
    text: fm('config:\n  theme forest'),
    code: 'yaml-unreadable-line',
    line: 3,
    says: 'not "key: value"',
  },
  {
    shape: 'a key with a dot in it',
    text: fm('config:\n  flowchart.curve: step'),
    code: 'yaml-unreadable-line',
    line: 3,
    says: 'flowchart.curve',
  },
  {
    shape: 'a value with an unquoted colon',
    text: fm('title: Plan: the sequel\nconfig:\n  theme: forest'),
    code: 'yaml-unreadable-value',
    line: 2,
    says: 'a colon',
  },
  {
    shape: 'a capitalised boolean',
    text: fm('config:\n  markdownAutoWrap: True'),
    code: 'yaml-unreadable-value',
    line: 3,
    says: 'True',
  },
  {
    shape: 'a hexadecimal number',
    text: fm('config:\n  handDrawnSeed: 0x1F'),
    code: 'yaml-unreadable-value',
    line: 3,
    says: '0x1F',
  },
  {
    shape: 'a number with a leading zero',
    text: fm('config:\n  handDrawnSeed: 012'),
    code: 'yaml-unreadable-value',
    line: 3,
    says: '012',
  },
  {
    shape: 'a double-quoted value with a YAML-only escape',
    text: fm('title: "a\\x41"\nconfig:\n  theme: forest'),
    code: 'yaml-unreadable-value',
    line: 2,
    says: 'an escape',
  },
  {
    shape: 'config given a single value',
    text: fm('config: forest'),
    code: 'config-is-not-a-mapping',
    line: 2,
    says: '"config" a single value',
  },
  {
    shape: 'a title holding other keys',
    text: fm('title:\n  nested: x\nconfig:\n  theme: forest'),
    code: 'yaml-unreadable-value',
    line: 2,
    says: '"title" holding other keys',
  },
  {
    shape: 'a frontmatter that is never closed',
    text: `---\nconfig:\n  theme: forest\n${FLOW}`,
    code: 'frontmatter-not-closed',
    line: 1,
    says: 'never closed',
  },
  {
    shape: 'an indented opening fence',
    text: `  ---\nconfig:\n  theme: forest\n---\n${FLOW}`,
    code: 'frontmatter-fence-indented',
    line: 1,
    says: 'indented opening',
  },
  {
    shape: 'two fences with nothing between them',
    text: `---\n---\n${FLOW}`,
    code: 'frontmatter-empty',
    line: 1,
    says: 'nothing between them',
  },
  {
    shape: 'a frontmatter with no diagram after it',
    text: '---\nconfig:\n  theme: forest\n---\n',
    code: 'frontmatter-without-diagram',
    line: 4,
    says: 'no diagram after it',
  },
]

describe('a frontmatter that cannot be kept exactly', () => {
  it.each(UNSUPPORTED)('is not guessed at when it has $shape', ({ text, code }) => {
    const reading = readMermaidSourceConfig(text)
    expect(reading.frontmatter).toMatchObject({ state: 'unreadable', refusal: { code } })
    // Not `unset`: the text may well set a theme, and the control must not
    // claim the diagram has none.
    expect(valueOf(text, 'theme').state).toBe('unknown')
    expect(listMermaidFrontmatterConfig(reading)).toEqual([])
  })

  it.each(UNSUPPORTED)('is refused BY NAME, with the line, when it has $shape', ({ text, code, line, says }) => {
    const refusal = refusalOf(text, [set('theme', 'dark')])
    expect([refusal.code, refusal.line]).toEqual([code, line])
    expect(refusal.message).toContain(says)
    expect(refusal.message).toContain('nothing was changed')
  })

  it.each(UNSUPPORTED)('is not touched by a removal either when it has $shape', ({ text, code }) => {
    // Reset is a removal. It gets no licence to rewrite what a set may not.
    expect(refusalOf(text, [unset('theme')]).code).toBe(code)
  })

  it.each(UNSUPPORTED)(
    'can be described without claiming anything was attempted, when it has $shape',
    ({ text, says }) => {
      // The panel notices such a frontmatter when it opens, before any control is
      // touched; "so nothing was changed" would then be a sentence about nothing.
      const reading = readMermaidSourceConfig(text)
      if (reading.frontmatter.state !== 'unreadable') {
        throw new Error('read after all')
      }
      const described = describeUnreadableFrontmatter(reading.frontmatter.refusal)
      expect(described).toContain(says)
      expect(described).not.toContain('nothing was changed')
      expect(described.endsWith('.')).toBe(true)
      expect(reading.frontmatter.refusal.message.startsWith(described)).toBe(true)
    },
  )

  it('names every shape the plan promised to refuse', () => {
    const named = new Set(UNSUPPORTED.map((entry) => entry.code))
    for (const code of [
      'yaml-comment',
      'yaml-anchor',
      'yaml-flow-collection',
      'yaml-multi-line-scalar',
      'unknown-top-level-key',
    ] as MermaidConfigRefusalCode[]) {
      expect([code, named.has(code)]).toEqual([code, true])
    }
  })
})

describe('writing an option into a diagram that has no frontmatter', () => {
  it('puts a block in front of the diagram, and nothing else changes', () => {
    expect(patched(FLOW, [set('theme', 'forest')])).toBe(`---\nconfig:\n  theme: forest\n---\n${FLOW}`)
  })

  it('writes a nested option under its group', () => {
    expect(patched(FLOW, [set('flowchart.curve', 'linear')])).toBe(
      `---\nconfig:\n  flowchart:\n    curve: linear\n---\n${FLOW}`,
    )
  })

  it('writes several options as one block, groups shared, in the order asked', () => {
    const text = patched(FLOW, [
      set('look', 'handDrawn'),
      set('handDrawnSeed', 7),
      set('themeVariables.fontSize', '20px'),
      set('flowchart.nodeSpacing', 80),
      set('flowchart.rankSpacing', 80),
    ])
    expect(text).toBe(
      [
        '---',
        'config:',
        '  look: handDrawn',
        '  handDrawnSeed: 7',
        '  themeVariables:',
        '    fontSize: "20px"',
        '  flowchart:',
        '    nodeSpacing: 80',
        '    rankSpacing: 80',
        '---',
        FLOW,
      ].join('\n'),
    )
  })

  it('goes in front of leading blank lines too, so taking it away restores them', () => {
    expect(patched(`\n\n${FLOW}`, [set('theme', 'dark')])).toBe(`---\nconfig:\n  theme: dark\n---\n\n\n${FLOW}`)
  })

  it('uses the diagram’s own line endings for the lines it adds', () => {
    const windows = FLOW.split('\n').join('\r\n')
    expect(patched(windows, [set('theme', 'dark')])).toBe(`---\r\nconfig:\r\n  theme: dark\r\n---\r\n${windows}`)
  })

  it('works on a diagram that is a single line with no line ending', () => {
    expect(patched('graph TD; A-->B', [set('theme', 'dark')])).toBe('---\nconfig:\n  theme: dark\n---\ngraph TD; A-->B')
  })

  it('refuses an empty diagram: there is nothing to give options to', () => {
    expect(refusalOf('', [set('theme', 'dark')]).code).toBe('empty-diagram')
    expect(refusalOf('  \n\n', [set('theme', 'dark')]).code).toBe('empty-diagram')
  })
})

describe('writing an option into a frontmatter that is already there', () => {
  it('adds config after what the frontmatter already holds', () => {
    expect(patched(fm('title: Plan'), [set('theme', 'forest')])).toBe(fm('title: Plan\nconfig:\n  theme: forest'))
  })

  it('adds a key at the end of config, before whatever follows config', () => {
    expect(patched(fm('config:\n  look: classic\ntitle: Plan'), [set('theme', 'forest')])).toBe(
      fm('config:\n  look: classic\n  theme: forest\ntitle: Plan'),
    )
  })

  it('adds a nested key at the end of its own group, not at the end of config', () => {
    expect(
      patched(fm('config:\n  flowchart:\n    curve: step\n  theme: dark'), [set('flowchart.nodeSpacing', 30)]),
    ).toBe(fm('config:\n  flowchart:\n    curve: step\n    nodeSpacing: 30\n  theme: dark'))
  })

  it('fills in a config key that had nothing under it', () => {
    expect(patched(fm('config:\ntitle: Plan'), [set('theme', 'dark')])).toBe(fm('config:\n  theme: dark\ntitle: Plan'))
  })

  it('replaces a value on its own line and keeps that line’s spelling', () => {
    // The key's indentation, the spaces round its colon and the line ending are
    // the person's; only the value is this file's to write.
    const text = '---\r\nconfig:\r\n    theme :   "forest"\r\n---\r\n' + FLOW
    expect(patched(text, [set('theme', 'dark')])).toBe('---\r\nconfig:\r\n    theme :   dark\r\n---\r\n' + FLOW)
  })

  it('gives a value to a key that had none', () => {
    expect(patched(fm('config:\n  theme:\n  look: classic'), [set('theme', 'dark')])).toBe(
      fm('config:\n  theme: dark\n  look: classic'),
    )
  })

  it('follows the frontmatter’s own indentation, whatever it is', () => {
    expect(patched(fm('config:\n    look: classic'), [set('flowchart.curve', 'step')])).toBe(
      fm('config:\n    look: classic\n    flowchart:\n        curve: step'),
    )
    expect(patched(fm('  title: Plan'), [set('theme', 'dark')])).toBe(fm('  title: Plan\n  config:\n    theme: dark'))
  })

  it('keeps blank lines where they were', () => {
    expect(patched(fm('\nconfig:\n\n  look: classic\n\ntitle: Plan\n'), [set('theme', 'dark')])).toBe(
      fm('\nconfig:\n\n  look: classic\n  theme: dark\n\ntitle: Plan\n'),
    )
  })

  it('will not write under a key that holds a single value', () => {
    const refusal = refusalOf(fm('config:\n  flowchart: 3'), [set('flowchart.curve', 'step')])
    expect([refusal.code, refusal.line, refusal.key]).toEqual(['key-holds-a-value', 3, 'flowchart.curve'])
  })

  it('will not give a single value to a key that holds a group', () => {
    const refusal = refusalOf(fm('config:\n  theme:\n    name: forest'), [set('theme', 'dark')])
    expect([refusal.code, refusal.line, refusal.key]).toEqual(['key-holds-a-mapping', 3, 'theme'])
  })

  it('writes all of the changes or none of them', () => {
    const text = fm('config:\n  flowchart: 3')
    const result = patchMermaidSourceConfig(text, [set('theme', 'dark'), set('flowchart.curve', 'step')])
    expect(result).toMatchObject({ ok: false, refusal: { code: 'key-holds-a-value' } })
    expect(result).not.toHaveProperty('text')
  })

  it('hands back the very same text when asked for no change', () => {
    const text = fm('# a comment it would otherwise refuse\nconfig:\n  theme: dark')
    expect(patchMermaidSourceConfig(text, [])).toEqual({ ok: true, text })
  })
})

/**
 * The texts the two proofs below run over. Each is a diagram a person could
 * have: none, some or all of a frontmatter, in three line-ending conventions
 * and two indentation habits.
 */
const BASES: { name: string; text: string }[] = [
  { name: 'no frontmatter', text: FLOW },
  { name: 'no frontmatter, no final line ending, one line', text: 'graph TD; A-->B' },
  { name: 'no frontmatter, blank lines first', text: `\n\n${FLOW}\n` },
  { name: 'no frontmatter, Windows line endings', text: FLOW.split('\n').join('\r\n') + '\r\n' },
  { name: 'no frontmatter, a directive first', text: `%%{init: {"sequence":{"actorMargin":20}}}%%\n${FLOW}` },
  { name: 'a title only', text: fm('title: Plan') },
  { name: 'a title only, Windows line endings', text: fm('title: Plan').split('\n').join('\r\n') },
  { name: 'config with another group', text: fm('config:\n  sequence:\n    showSequenceNumbers: true') },
  { name: 'config between two other keys', text: fm('title: Plan\nconfig:\n  layout: dagre\ndisplayMode: compact') },
  { name: 'four-space indentation', text: fm('config:\n    sequence:\n        actorMargin: 20\ntitle: Plan') },
  { name: 'blank lines inside', text: fm('\ntitle: Plan\n\nconfig:\n\n  layout: dagre\n\n') },
  { name: 'trailing spaces on the fences', text: `---  \ntitle: Plan  \n---  \n\n${FLOW}` },
  { name: 'an empty frontmatter', text: `---\n\n---\n${FLOW}` },
]

/** Change sets a control or a preset would ask for — none names a key a base already has. */
const CHANGE_SETS: { name: string; changes: MermaidConfigChange[] }[] = [
  { name: 'a theme', changes: [set('theme', 'forest')] },
  { name: 'a look and its seed', changes: [set('look', 'handDrawn'), set('handDrawnSeed', 7)] },
  { name: 'a text size', changes: [set('themeVariables.fontSize', '20px')] },
  {
    name: 'flowchart spacing',
    changes: [set('flowchart.nodeSpacing', 30), set('flowchart.rankSpacing', 30), set('flowchart.padding', 8)],
  },
  {
    name: 'a whole preset',
    changes: [
      set('theme', 'neutral'),
      set('look', 'handDrawn'),
      set('handDrawnSeed', 7),
      set('themeVariables.fontSize', '20px'),
      set('flowchart.curve', 'linear'),
      set('flowchart.nodeSpacing', 80),
      set('flowchart.rankSpacing', 80),
    ],
  },
]

describe('a patch changes frontmatter lines and no others', () => {
  const cases = BASES.flatMap((base) => CHANGE_SETS.map((changeSet) => ({ base, changeSet })))

  it.each(cases)('adding $changeSet.name to a diagram with $base.name', ({ base, changeSet }) => {
    const after = patched(base.text, changeSet.changes)
    const { removed, added } = lineDiff(base.text, after)
    const spanBefore = frontmatterSpan(base.text)
    const spanAfter = frontmatterSpan(after)
    expect(spanAfter).not.toBeNull()
    // Adding only ever ADDS lines: no line of the original is gone or altered.
    expect(removed).toEqual([])
    expect(added.length).toBeGreaterThan(0)
    for (const index of added) {
      expect([index, index >= spanAfter!.first && index <= spanAfter!.last]).toEqual([index, true])
    }
    // Everything after the frontmatter is the original, byte for byte.
    const bodyBefore = linesOf(base.text).slice(spanBefore === null ? 0 : spanBefore.last + 1)
    expect(linesOf(after).slice(spanAfter!.last + 1)).toEqual(bodyBefore)
    // And a fence this file did not write is the fence it was.
    if (spanBefore !== null) {
      expect(linesOf(after)[spanAfter!.first]).toBe(linesOf(base.text)[spanBefore.first])
      expect(linesOf(after)[spanAfter!.last]).toBe(linesOf(base.text)[spanBefore.last])
    }
  })

  it('changing a value alters exactly one line', () => {
    const before = fm('title: Plan\nconfig:\n  theme: forest\n  flowchart:\n    curve: step')
    const after = patched(before, [set('flowchart.curve', 'linear')])
    expect(lineDiff(before, after)).toEqual({ removed: [5], added: [5] })
    expect(linesOf(after)[5]).toBe('    curve: linear\n')
  })

  it('removing a value removes its line, and its group’s when that is left empty', () => {
    const before = fm('title: Plan\nconfig:\n  theme: forest\n  flowchart:\n    curve: step')
    expect(lineDiff(before, patched(before, [unset('flowchart.curve')]))).toEqual({ removed: [4, 5], added: [] })
    expect(lineDiff(before, patched(before, [unset('theme')]))).toEqual({ removed: [3], added: [] })
  })

  it('ran over the whole grid', () => {
    expect(cases.length).toBe(BASES.length * CHANGE_SETS.length)
    expect(cases.length).toBeGreaterThanOrEqual(60)
  })
})

describe('what was written can be taken away again, to the byte', () => {
  const cases = BASES.flatMap((base) => CHANGE_SETS.map((changeSet) => ({ base, changeSet })))

  it.each(cases)('$changeSet.name, on a diagram with $base.name', ({ base, changeSet }) => {
    const written = patched(base.text, changeSet.changes)
    expect(written).not.toBe(base.text)
    const removals = changeSet.changes.map((change) => ({ path: change.path, value: undefined }))
    expect(patched(written, removals)).toBe(base.text)
    // In the opposite order as well: which key goes last must not matter.
    expect(patched(written, [...removals].reverse())).toBe(base.text)
    // And one key at a time, each as its own edit, as a person would undo them.
    let stepwise = written
    for (const removal of removals) {
      stepwise = patched(stepwise, [removal])
    }
    expect(stepwise).toBe(base.text)
  })

  it('reads back every value it wrote before taking it away', () => {
    for (const base of BASES) {
      for (const changeSet of CHANGE_SETS) {
        const written = patched(base.text, changeSet.changes)
        for (const change of changeSet.changes) {
          expect(readMermaidConfigValue(readMermaidSourceConfig(written), change.path)).toMatchObject({
            state: 'set',
            value: change.value,
            from: 'frontmatter',
          })
        }
      }
    }
  })

  it('removes the whole frontmatter when the last key it holds goes', () => {
    expect(patched(fm('config:\n  theme: forest'), [unset('theme')])).toBe(FLOW)
    expect(patched(fm('config:\n  flowchart:\n    curve: step'), [unset('flowchart.curve')])).toBe(FLOW)
  })

  it('keeps a frontmatter that still holds something', () => {
    expect(patched(fm('title: Plan\nconfig:\n  theme: forest'), [unset('theme')])).toBe(fm('title: Plan'))
    expect(patched(fm('config:\n  theme: forest\n  look: classic'), [unset('theme')])).toBe(
      fm('config:\n  look: classic'),
    )
    expect(patched(fm('config:\n  flowchart:\n    curve: step\n    padding: 8'), [unset('flowchart.curve')])).toBe(
      fm('config:\n  flowchart:\n    padding: 8'),
    )
  })

  it('keeps the fences when a blank line is all that is left between them', () => {
    // Still a frontmatter to mermaid, and it may have been there before this
    // file wrote anything: `---`, blank, `---` round-trips through a set and a
    // removal exactly because of this.
    expect(patched(fm('\nconfig:\n  theme: forest'), [unset('theme')])).toBe(`---\n\n---\n${FLOW}`)
  })

  it('changes nothing when the key is not there', () => {
    for (const base of BASES) {
      expect(patched(base.text, [unset('theme'), unset('flowchart.curve')])).toBe(base.text)
    }
  })

  it('will not remove a key that holds a group', () => {
    expect(refusalOf(fm('config:\n  theme:\n    name: forest'), [unset('theme')]).code).toBe('key-holds-a-mapping')
  })
})

describe('an init directive that already sets the key', () => {
  const DIRECTED = `%%{init: {"theme":"forest","flowchart":{"curve":"step"}}}%%\n${FLOW}`

  it('refuses the change, names the key and the line, and says the directive wins', () => {
    const refusal = refusalOf(DIRECTED, [set('theme', 'dark')])
    expect([refusal.code, refusal.line, refusal.key]).toEqual(['directive-sets-key', 1, 'theme'])
    expect(refusal.message).toContain('Line 1 is an init directive that sets "theme"')
    expect(refusal.message).toContain('a directive wins over the frontmatter')
    expect(refusal.message).toContain('Nothing was changed')
  })

  it('refuses a nested key the directive sets', () => {
    expect(refusalOf(DIRECTED, [set('flowchart.curve', 'linear')])).toMatchObject({
      code: 'directive-sets-key',
      key: 'flowchart.curve',
    })
  })

  it('finds the directive below a frontmatter and counts its line in the whole text', () => {
    const refusal = refusalOf(fm('title: Plan', DIRECTED), [set('theme', 'dark')])
    expect([refusal.code, refusal.line]).toEqual(['directive-sets-key', 4])
  })

  it('still writes a key the directive does not set', () => {
    expect(patched(DIRECTED, [set('look', 'handDrawn')])).toBe(`---\nconfig:\n  look: handDrawn\n---\n${DIRECTED}`)
    expect(patched(DIRECTED, [set('flowchart.nodeSpacing', 30)])).toBe(
      `---\nconfig:\n  flowchart:\n    nodeSpacing: 30\n---\n${DIRECTED}`,
    )
  })

  it('refuses the whole change set when the directive sets one key of it', () => {
    expect(patchMermaidSourceConfig(DIRECTED, [set('look', 'handDrawn'), set('theme', 'dark')])).toMatchObject({
      ok: false,
      refusal: { code: 'directive-sets-key', key: 'theme' },
    })
  })

  it('does not refuse a removal: taking a key out of the frontmatter is always possible', () => {
    const text = fm('config:\n  theme: dark\n  look: classic', DIRECTED)
    expect(patched(text, [unset('theme')])).toBe(fm('config:\n  look: classic', DIRECTED))
    expect(patched(DIRECTED, [unset('theme')])).toBe(DIRECTED)
  })

  it('refuses under a directive it cannot follow, rather than assume it sets nothing', () => {
    const refusal = refusalOf(`%%{init: {"config":{"curve":"step"}}}%%\n${FLOW}`, [set('theme', 'dark')])
    expect([refusal.code, refusal.line]).toEqual(['directive-sets-key', 1])
  })
})

describe('what a value is written as', () => {
  it('writes a simple word bare, as mermaid’s own documentation does', () => {
    expect(emitMermaidConfigScalar('forest')).toBe('forest')
    expect(emitMermaidConfigScalar('neo-dark')).toBe('neo-dark')
    expect(emitMermaidConfigScalar('handDrawn')).toBe('handDrawn')
  })

  it('quotes anything YAML could take for something else', () => {
    expect(emitMermaidConfigScalar('20px')).toBe('"20px"')
    expect(emitMermaidConfigScalar('#ffcc00')).toBe('"#ffcc00"')
    expect(emitMermaidConfigScalar('')).toBe('""')
    for (const word of ['true', 'False', 'NULL', 'yes', 'No', 'on', 'OFF', 'y', 'n']) {
      expect(emitMermaidConfigScalar(word)).toBe(JSON.stringify(word))
    }
  })

  it('writes numbers and booleans as themselves', () => {
    expect(emitMermaidConfigScalar(30)).toBe('30')
    expect(emitMermaidConfigScalar(0.75)).toBe('0.75')
    expect(emitMermaidConfigScalar(-3)).toBe('-3')
    expect(emitMermaidConfigScalar(true)).toBe('true')
    expect(emitMermaidConfigScalar(false)).toBe('false')
  })

  it('reads back exactly the string it wrote, however awkward', () => {
    const awkward = [
      'a b',
      'a: b',
      'a #b',
      '"quoted"',
      "it's",
      'back\\slash',
      '  padded  ',
      '12',
      'true',
      '~',
      '- x',
      '{a}',
      'é ü 日本',
    ]
    for (const value of awkward) {
      const text = patched(FLOW, [set('themeVariables.fontFamilyProbe', value)])
      expect([value, valueOfRaw(text)]).toEqual([value, value])
    }
  })

  const valueOfRaw = (text: string) =>
    listMermaidFrontmatterConfig(readMermaidSourceConfig(text)).find(
      (item) => item.key === 'themeVariables.fontFamilyProbe',
    )?.value

  it('will not write a change that is not one', () => {
    for (const change of [
      { path: [], value: 'x' },
      { path: ['a b'], value: 'x' },
      { path: ['flowchart', 'cur:ve'], value: 'x' },
      { path: ['handDrawnSeed'], value: Number.NaN },
      { path: ['handDrawnSeed'], value: Number.POSITIVE_INFINITY },
      { path: ['theme'], value: 'for\nest' },
      { path: ['theme'], value: 'for\test' },
    ] as MermaidConfigChange[]) {
      expect(refusalOf(FLOW, [change]).code).toBe('invalid-change')
    }
  })
})
