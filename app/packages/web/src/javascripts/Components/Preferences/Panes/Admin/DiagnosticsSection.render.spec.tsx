/**
 * @jest-environment jsdom
 *
 * DiagnosticsSection render guard (MEMORY: verify UI render paths). This repo has
 * twice shipped admin UI that typechecked, tested clean and never appeared on
 * screen, so this drives the REAL renderer in jsdom and asserts the text an
 * operator would actually read.
 *
 * There is no `@testing-library/react` in this package; the harness is
 * `react-dom/client` + `act`, matching `AdminDiagnosticsTab.spec.tsx`. Nothing
 * here asserts a height, a scroll position or an overflow: jsdom has no layout
 * engine and every measurement it reports is zero, so a test that claimed to
 * check one would be proving nothing.
 *
 * The capped-claim case is the important one. A section that asks for a healthy
 * verdict on proxy evidence must paint "Unknown" and print the caveat, not "OK" —
 * that is the whole defect this contract exists to make unexpressible, and
 * `diagnosticsSections.spec.ts` pins it in the model while this pins it on screen.
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'

import DiagnosticsSection from './DiagnosticsSection'
import {
  buildSectionModel,
  diagnosticFinding,
  diagnosticRow,
  EVIDENCE_ABSENT,
  EVIDENCE_DIRECT,
  evidenceProxy,
  NOT_PUBLISHED,
  READING_MEANING,
  READING_TAG,
  safeConstant,
  safeCount,
  safeEnum,
  safeState,
  type SectionModel,
  type SectionTaggedOutcome,
  type Verdict,
} from './diagnosticsSections'
import type { Remedy } from './diagnosticRemedies'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SECRET = 'redis://admin:hunter2@redis.internal.example:6379'

const remedy: Remedy = {
  code: 'SYNCING_SERVER_GRPC_UNBOUND',
  summary: 'Set SERVICE_PROXY_TYPE to grpc and restart the container.',
  steps: ['Set SERVICE_PROXY_TYPE=grpc', 'Restart the container'],
  effort: 'restart',
  basis: 'verified',
  because: ['The gRPC syncing proxy was not bound at boot.'],
}

const outcome: SectionTaggedOutcome = {
  name: 'Ticket mint',
  passed: false,
  detail: 'The gateway answered 503 SYNC_DISABLED.',
  reportDetail: 'ticket mint refused: SYNC_DISABLED',
  section: 'websocket',
}

const model = (): SectionModel =>
  buildSectionModel({
    id: 'websocket',
    blocks: [
      {
        heading: safeConstant('Lane and boot gate'),
        description: 'Whether the socket lane was built at boot and which operations it may offer.',
        rows: [
          diagnosticRow({
            label: safeConstant('Gateway'),
            value: safeState(true, 'attached', 'not attached'),
            verdict: 'healthy',
            evidence: EVIDENCE_DIRECT,
            note: 'A websocket gateway is attached to this process.',
          }),
          diagnosticRow({
            label: safeConstant('SYNC_ITEMS'),
            value: safeState(true, 'advertised', 'withheld'),
            verdict: 'healthy',
            evidence: evidenceProxy({
              observed: 'that the gRPC syncing proxy was bound at boot',
              cannotConfirm: 'that the handshake advertises SYNC_ITEMS',
              necessaryCondition: true,
            }),
            note: 'Read from the boot gate, not from a handshake.',
          }),
          diagnosticRow({
            label: safeConstant('Live sockets'),
            value: safeCount(undefined),
            verdict: 'healthy',
            evidence: EVIDENCE_ABSENT,
            note: 'This server build reports no socket counters.',
          }),
          diagnosticRow({
            label: safeConstant('Bound service proxy'),
            value: safeEnum(SECRET, ['grpc', 'http', 'direct-call']),
            verdict: 'informational',
            evidence: EVIDENCE_DIRECT,
            note: 'Which internal transport the gateway composed.',
          }),
        ],
        findings: [
          diagnosticFinding({
            code: safeConstant('SYNC_ITEMS_WITHHELD'),
            title: 'Note syncing is falling back to HTTP',
            detail: 'The socket stays up and carries collaboration, but SYNC_ITEMS is not negotiated.',
            verdict: 'degraded',
            evidence: EVIDENCE_DIRECT,
            remedy,
          }),
        ],
        outcomes: [outcome],
      },
      {
        heading: safeConstant('Realtime health'),
        description: 'What the attached gateway says about itself right now.',
        rows: [],
        findings: [],
        emptyNote: 'This server reported no realtime health snapshot.',
      },
    ],
  })

let container: HTMLElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

const render = async (section: SectionModel): Promise<string> => {
  await act(async () => {
    root.render(createElement(DiagnosticsSection, { model: section }))
  })
  return container.textContent ?? ''
}

const chips = (): string[] => [...container.querySelectorAll('span')].map((element) => element.textContent ?? '')

/**
 * The chip rendered on ONE named row.
 *
 * Asserting on the set of chip texts is not enough here: every interesting case
 * in the fixture is a row that asked for "healthy" and must not get "OK", and a
 * section-wide `toContain('OK')` is satisfied by any other row. This reads the
 * chip out of the row it belongs to, which is what makes the capped-claim
 * assertions below able to fail.
 */
const rowChip = (label: string): string | undefined => {
  const row = [...container.querySelectorAll('tr')].find(
    (element) => element.querySelector('td')?.textContent === label,
  )
  return [...(row?.querySelectorAll('span') ?? [])].map((element) => element.textContent ?? '')[0]
}

describe('DiagnosticsSection', () => {
  it('renders the section title, its worst-verdict chip and every block heading', async () => {
    const text = await render(model())

    expect(text).toContain('WebSocket')
    expect(text).toContain('Lane and boot gate')
    expect(text).toContain('Realtime health')
    expect(text).toContain('Whether the socket lane was built at boot')
    // Worst across the whole section is the degraded finding.
    expect(chips()).toContain('Degraded')
    expect(container.querySelector('[data-diagnostics-section="websocket"]')).not.toBeNull()
  })

  it('renders each row label, its safe value and its note', async () => {
    const text = await render(model())

    expect(text).toContain('Gateway')
    expect(text).toContain('attached')
    expect(text).toContain('A websocket gateway is attached to this process.')
    expect(rowChip('Gateway')).toBe('OK')
  })

  it('paints a claim built on a proxy as Unknown, never as OK, and prints the caveat', async () => {
    const text = await render(model())

    expect(rowChip('SYNC_ITEMS')).toBe('Unknown')
    expect(text).toContain('does not establish')
    expect(text).toContain('that the handshake advertises SYNC_ITEMS')
  })

  it('distinguishes a value that was never reported from one that is bad', async () => {
    const text = await render(model())

    expect(text).toContain('not reported')
    expect(text).toContain('An unreported field is not a negative answer.')
    expect(rowChip('Live sockets')).toBe('Unknown')
    expect(chips()).not.toContain('Down')
  })

  it('keeps a row that was never a verdict out of the verdict vocabulary', async () => {
    await render(model())

    expect(rowChip('Bound service proxy')).toBe('Info')
  })

  it('never echoes a value that failed its closed enum', async () => {
    const text = await render(model())

    expect(text).toContain('other (unrecognised)')
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain('redis.internal.example')
  })

  it('renders findings with their remedy, steps and evidence', async () => {
    const text = await render(model())

    expect(text).toContain('Note syncing is falling back to HTTP')
    expect(text).toContain('Set SERVICE_PROXY_TYPE to grpc and restart the container.')
    expect(text).toContain('Set SERVICE_PROXY_TYPE=grpc')
    expect(text).toContain('The gRPC syncing proxy was not bound at boot.')
    expect(chips()).toContain('Config + restart')
  })

  it('renders probe outcomes read-only and says where a run is started', async () => {
    const text = await render(model())

    expect(text).toContain('Ticket mint')
    expect(text).toContain('The gateway answered 503 SYNC_DISABLED.')
    expect(text).toContain('only place a run can be started')
    expect(container.querySelectorAll('button')).toHaveLength(0)
  })

  it('says in words that an empty block carried nothing', async () => {
    const text = await render(model())

    expect(text).toContain('This server reported no realtime health snapshot.')
  })

  it('falls back to its own sentence for an empty block with no note', async () => {
    const text = await render(
      buildSectionModel({
        id: 'browser',
        blocks: [{ heading: safeConstant('Secure context'), description: 'd', rows: [], findings: [] }],
      }),
    )

    expect(text).toContain('not the same as everything being fine')
  })

  it('claims nothing for a section with no blocks at all', async () => {
    const text = await render(buildSectionModel({ id: 'account', blocks: [] }))

    expect(text).toContain('no blocks')
    expect(chips()).toContain('Unknown')
    expect(chips()).not.toContain('OK')
  })

  /**
   * The unmapped-`Icon` hazard: an `Icon` whose `type` is absent from
   * `IconNameToSvgMapping.ts` renders its own name as literal text, and both tsc
   * and any spec that mocks `Icon` are blind to it. This renderer is text-only,
   * and this is the assertion that keeps it that way — adding an icon fails here
   * first, which is the point at which the mapping has to be proven.
   */
  it('emits no SVG, so no section can acquire an unmapped icon unnoticed', async () => {
    await render(model())

    expect(container.querySelectorAll('svg')).toHaveLength(0)
  })
})

/**
 * *** THE THREE SILENCES, ON SCREEN. ***
 *
 * The model has always kept "a value arrived", "we asked and nothing came back"
 * and "nothing publishes this" apart, and the screen printed the last two as two
 * sentences in the value column that a reader had to parse. Each row now carries
 * `data-diagnostics-reading`, the two silences carry a tag, and each block states
 * its own census.
 */
describe('DiagnosticsSection — the three silences', () => {
  const threeReadings = (): SectionModel =>
    buildSectionModel({
      id: 'browser',
      blocks: [
        {
          heading: safeConstant('Readings'),
          description: 'One row of each reading.',
          rows: [
            diagnosticRow({
              label: safeConstant('Answered'),
              value: safeState(true, 'attached', 'not attached'),
              verdict: 'healthy',
              evidence: EVIDENCE_DIRECT,
              note: 'the server answered',
            }),
            diagnosticRow({
              label: safeConstant('Unanswered'),
              value: safeCount(undefined),
              verdict: 'healthy',
              evidence: EVIDENCE_ABSENT,
              note: 'nothing came back',
            }),
            diagnosticRow({
              label: safeConstant('Unpublished'),
              value: NOT_PUBLISHED,
              verdict: 'informational',
              evidence: EVIDENCE_ABSENT,
              note: 'nothing publishes it',
            }),
          ],
          findings: [],
        },
      ],
    })

  const readingOfRow = (label: string): string | null => {
    const row = [...container.querySelectorAll('tr')].find(
      (element) => element.querySelector('td')?.textContent === label,
    )
    expect(row).toBeDefined()

    return row?.getAttribute('data-diagnostics-reading') ?? null
  }

  it('tags each row with the reading its own value establishes', async () => {
    await render(threeReadings())

    expect(readingOfRow('Answered')).toBe('answered')
    expect(readingOfRow('Unanswered')).toBe('unanswered')
    expect(readingOfRow('Unpublished')).toBe('unpublished')
  })

  it('prints a tag for each silence and none for a value', async () => {
    await render(threeReadings())

    const tagsIn = (label: string): string[] => {
      const row = [...container.querySelectorAll('tr')].find(
        (element) => element.querySelector('td')?.textContent === label,
      )
      const note = [...(row?.querySelectorAll('td') ?? [])][3]

      return [...note.querySelectorAll('span')].map((element) => element.textContent ?? '')
    }

    expect(tagsIn('Answered')).toEqual([])
    expect(tagsIn('Unanswered')).toEqual([READING_TAG.unanswered])
    expect(tagsIn('Unpublished')).toEqual([READING_TAG.unpublished])
  })

  /**
   * The verdict chip must stay the FIRST span in a row. Two specs and the whole
   * Admin tab suite read a row's chip that way, and a tag rendered before it would
   * silently redirect sixty assertions onto the wrong element.
   */
  it('keeps the verdict chip as the first span in every row', async () => {
    await render(threeReadings())

    for (const label of ['Answered', 'Unanswered', 'Unpublished']) {
      expect(rowChip(label)).toBeDefined()
      expect(['OK', 'Unknown', 'Info', 'Degraded', 'Down']).toContain(rowChip(label))
    }
  })

  it('states each block’s own census, so a block of silences is visible as one', async () => {
    await render(threeReadings())
    const block = container.querySelector('[data-diagnostics-block="Readings"]')

    expect(block?.getAttribute('data-diagnostics-census')).toBe('answered=1,unanswered=1,unpublished=1')
    expect(block?.querySelector('summary')?.textContent).toContain('3 rows: 1 answered · 1 no answer · 1 no source')
  })

  it('explains all three readings once per section, including the one with no tag', async () => {
    const text = await render(threeReadings())

    expect(text).toContain(READING_MEANING.answered)
    expect(text).toContain(READING_MEANING.unanswered)
    expect(text).toContain(READING_MEANING.unpublished)
    expect(text).toContain(READING_TAG.unanswered)
  })
})

/**
 * *** THE NOISE COLLAPSES, AND THE ROWS STAY IN THE DOM. ***
 *
 * The second half is the one that matters most here. If a collapsed block omitted
 * its rows, the poisoned-sentinel sweeps in `AdminDiagnosticsTab.spec.tsx` — which
 * read `container.textContent` — would pass because the rows they assert about
 * were never rendered. That is the recorded failure mode "an absence assertion
 * over a row that was never rendered proved nothing", and a closed `<details>` is
 * what avoids it: the content is present, styled away by the browser.
 */
describe('DiagnosticsSection — collapsing', () => {
  const blockFor = (heading: string): HTMLDetailsElement => {
    const element = container.querySelector(`[data-diagnostics-block="${heading}"]`)
    expect(element).not.toBeNull()

    return element as HTMLDetailsElement
  }

  /**
   * What the BROWSER does when the operator clicks a `<summary>`: it flips `open`
   * itself and fires `toggle`. jsdom does not do that for a synthetic click, so it
   * is done here in the same order — and the handler being wired is then asserted
   * through `data-diagnostics-open`, not assumed.
   */
  const toggle = async (heading: string, next: boolean) => {
    const element = blockFor(heading)
    await act(async () => {
      element.open = next
      element.dispatchEvent(new Event('toggle'))
    })
  }

  it('wires the toggle handler, so the component’s state follows the operator', async () => {
    await render(model())
    expect(blockFor('Realtime health').getAttribute('data-diagnostics-open')).toBe('false')

    await toggle('Realtime health', true)

    // If `onToggle` were not wired, the state would still read false here while
    // `.open` read true — which is exactly the pair of readings a mutation hid
    // behind, so this is asserted on its own rather than only in passing.
    expect(blockFor('Realtime health').getAttribute('data-diagnostics-open')).toBe('true')
  })

  it('opens a block with a finding and collapses one with nothing to act on', async () => {
    await render(model())

    expect(blockFor('Lane and boot gate').open).toBe(true)
    expect(blockFor('Realtime health').open).toBe(false)
  })

  /**
   * One heading per verdict, deliberately. The open state is React state seeded
   * ONCE on mount, and the block is keyed by its heading — so re-rendering the
   * same heading with a different verdict reuses the instance and keeps the
   * operator's own toggle, which is the behaviour the next test pins. Reusing one
   * heading here would therefore test the wrong thing and pass for the wrong
   * reason.
   */
  it('opens a block whose rows alone are degraded or broken, and keeps an undetermined one closed', async () => {
    const rowOnly = (verdict: Verdict): SectionModel =>
      buildSectionModel({
        id: 'backend',
        blocks: [
          {
            heading: safeConstant(`Rows ${verdict}` as 'Rows'),
            description: 'd',
            rows: [
              diagnosticRow({
                label: safeConstant('Row'),
                value: safeState(false, 'connected', 'disconnected'),
                verdict,
                evidence: EVIDENCE_DIRECT,
                note: 'n',
              }),
            ],
            findings: [],
          },
        ],
      })

    for (const verdict of ['broken', 'degraded'] as const) {
      await render(rowOnly(verdict))
      expect(blockFor(`Rows ${verdict}`).open).toBe(true)
    }
    for (const verdict of ['undetermined', 'healthy', 'informational'] as const) {
      await render(rowOnly(verdict))
      expect(blockFor(`Rows ${verdict}`).open).toBe(false)
    }
  })

  /**
   * *** THE TAB RE-READS THE TRANSPORT EVERY TWO SECONDS. ***
   *
   * Each poll rebuilds the section models, so a `<details open>` driven straight
   * from the model would snap shut under the operator's hands twice a second —
   * while they were reading the block they had just opened. The open state is React
   * state seeded once on mount and updated only by the element's own `toggle`
   * event, and this is what proves it: open a collapsed block by hand, re-render
   * with a FRESH model object, and it is still open.
   */
  it('keeps a block the operator opened open across a re-render', async () => {
    await render(model())
    const quiet = blockFor('Realtime health')
    expect(quiet.open).toBe(false)
    expect(quiet.getAttribute('data-diagnostics-open')).toBe('false')

    await toggle('Realtime health', true)
    expect(blockFor('Realtime health').open).toBe(true)
    // *** BOTH, AND THE SECOND IS THE LOAD-BEARING ONE. *** `.open` alone cannot
    // tell "the component's state followed the operator" from "the state is stale
    // and React happened not to write over the attribute", because React does not
    // rewrite an attribute whose rendered value has not changed.
    expect(blockFor('Realtime health').getAttribute('data-diagnostics-open')).toBe('true')

    // A fresh model, as the two-second poll produces.
    await render(model())
    expect(blockFor('Realtime health').open).toBe(true)
    expect(blockFor('Realtime health').getAttribute('data-diagnostics-open')).toBe('true')
  })

  it('keeps every row of a collapsed block in the DOM and in the rendered text', async () => {
    const text = await render(model())

    expect(blockFor('Realtime health').open).toBe(false)
    // The empty note of the collapsed block is still readable text.
    expect(text).toContain('This server reported no realtime health snapshot.')

    // And with rows: a collapsed block's rows are present and queryable.
    const collapsedRows = buildSectionModel({
      id: 'browser',
      blocks: [
        {
          heading: safeConstant('Quiet'),
          description: 'd',
          rows: [
            diagnosticRow({
              label: safeConstant('Storage estimate call'),
              value: safeCount(undefined),
              verdict: 'healthy',
              evidence: EVIDENCE_ABSENT,
              note: 'n',
            }),
          ],
          findings: [],
        },
      ],
    })
    const quiet = await render(collapsedRows)

    expect(blockFor('Quiet').open).toBe(false)
    expect(quiet).toContain('Storage estimate call')
    expect(quiet).toContain('not reported')
    expect(blockFor('Quiet').querySelectorAll('tbody tr')).toHaveLength(1)
  })

  /**
   * *** AND THE OTHER DIRECTION, WHICH IS THE ONE A MUTATION GOT PAST. ***
   *
   * The test above opens a block the model wanted CLOSED, so a mutant that
   * re-applied the model's opinion only when it said OPEN survived it: nothing
   * forced that block. The harm is symmetrical — an operator who collapses a noisy
   * open block has it forced back open two seconds later, which is worse than the
   * other way round because the open blocks are the long ones. So this closes one
   * the model wanted open and re-renders.
   */
  it('keeps a block the operator closed closed across a re-render', async () => {
    await render(model())
    const loud = blockFor('Lane and boot gate')
    expect(loud.open).toBe(true)

    await toggle('Lane and boot gate', false)
    expect(blockFor('Lane and boot gate').open).toBe(false)
    expect(blockFor('Lane and boot gate').getAttribute('data-diagnostics-open')).toBe('false')

    await render(model())
    expect(blockFor('Lane and boot gate').open).toBe(false)
    expect(blockFor('Lane and boot gate').getAttribute('data-diagnostics-open')).toBe('false')
  })

  /**
   * The disclosure control is a `<summary>`, not a `<button>`. The existing
   * assertion that a section renders no button is what keeps "a run can only be
   * started in one place" honest, and a disclosure control must not spend it.
   */
  it('uses a summary rather than a button as its disclosure control', async () => {
    await render(model())

    expect(container.querySelectorAll('button')).toHaveLength(0)
    expect(container.querySelectorAll('summary').length).toBe(model().blocks.length)
    expect(container.querySelectorAll('svg')).toHaveLength(0)
  })

  it('names the block and its verdict in the summary, so a collapsed block is still an index', async () => {
    await render(model())
    const summary = blockFor('Realtime health').querySelector('summary')?.textContent ?? ''

    expect(summary).toContain('Realtime health')
    expect(summary).toContain('Unknown')
  })
})
