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
  safeConstant,
  safeCount,
  safeEnum,
  safeState,
  type SectionModel,
  type SectionTaggedOutcome,
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
