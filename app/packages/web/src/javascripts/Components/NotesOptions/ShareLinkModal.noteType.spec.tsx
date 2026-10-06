/**
 * @jest-environment jsdom
 *
 * THE PRODUCER SIDE OF THE SHARE-LINK NOTE TYPE, PROVED BY WHAT THE READER SEES.
 *
 * `be8e9342` built a viewer that dispatches on a `noteType` the share envelope
 * did not carry, and reported the producer half as "one line in
 * ShareLinkModal.tsx". It is not one line: that report assumed an optional
 * `noteType` on `SharedNotePayload`, which the same agent added and then
 * reverted, so the literal one-line version is `error TS2353: Object literal may
 * only specify known properties, and 'noteType' does not exist in type
 * 'SharedNotePayload'` (measured on this tree with `yarn workspace
 * @standardnotes/web tsc`).
 *
 * These tests therefore do the whole round trip rather than asserting a field
 * was set: a REAL `SNNote` goes into the REAL `ShareLinkModal`, the envelope
 * that reaches `legacyApi.createShare` and the fragment key printed in the
 * modal's own link field are the only things carried across, and the REAL
 * `SharedView` is then mounted on them with a gateway-shaped `fetch`. Every
 * assertion below is about the DOM the reader gets.
 *
 * jsdom caveat, stated rather than hidden: it has no layout engine, so mermaid
 * and gantt produce no measured SVG here. The Super case asserts the structures
 * that do render (headings, lists, table, code block); the renderer agent's
 * harness measures the diagrams in real headless Chrome.
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'

/**
 * Real XChaCha20-Poly1305 for `encryptShare`/`decryptShare`.
 *
 * `shareCrypto.ts` constructs `SNWebCrypto` itself when no crypto is injected,
 * and `ShareLinkModal` injects none — so this is the call the product makes. The
 * package's published build is ESM that jest's CommonJS runtime cannot load, and
 * the web package's own `__mocks__` stub for it has an `initialize()` and
 * nothing else, which would make the envelope a lie. libsodium-sumo mirrors
 * `SNWebCrypto`'s primitives byte for byte (see `shareCrypto.spec.ts`), so the
 * ciphertext here is the real thing and the round trip is a real round trip.
 */
jest.mock('@standardnotes/sncrypto-web', () => {
  // `jest.requireActual`, not `require`: the latter is an eslint error in this
  // package, and the factory must not reach for the hoisted module binding.
  const sodiumLib = jest.requireActual('libsodium-wrappers-sumo')

  class SNWebCrypto {
    async initialize(): Promise<void> {
      await sodiumLib.ready
    }

    deinit(): void {}

    generateRandomKey(bits: number): string {
      return sodiumLib.to_hex(sodiumLib.randombytes_buf(bits / 8))
    }

    xchacha20Encrypt(plaintext: string, nonce: string, key: string, assocData?: string): string {
      return sodiumLib.to_base64(
        sodiumLib.crypto_aead_xchacha20poly1305_ietf_encrypt(
          plaintext,
          assocData || null,
          null,
          sodiumLib.from_hex(nonce),
          sodiumLib.from_hex(key),
        ),
        sodiumLib.base64_variants.ORIGINAL,
      )
    }

    xchacha20Decrypt(ciphertext: string, nonce: string, key: string, assocData?: string): string | null {
      try {
        return sodiumLib.crypto_aead_xchacha20poly1305_ietf_decrypt(
          null,
          sodiumLib.from_base64(ciphertext, sodiumLib.base64_variants.ORIGINAL),
          assocData || null,
          sodiumLib.from_hex(nonce),
          sodiumLib.from_hex(key),
          'text',
        )
      } catch {
        return null
      }
    }
  }

  return { SNWebCrypto }
})

jest.mock('@standardnotes/toast', () => ({
  addToast: jest.fn(),
  ToastType: { Success: 'success', Error: 'error', Regular: 'regular', Info: 'info', Loading: 'loading' },
}))

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

import sodium from 'libsodium-wrappers-sumo'
import {
  ContentType,
  DecryptedPayload,
  FillItemContent,
  NoteContent,
  NoteType,
  PayloadSource,
  PayloadTimestampDefaults,
  SNNote,
} from '@standardnotes/snjs'

import ApplicationProvider from '@/Components/ApplicationProvider'
import AndroidBackHandlerProvider from '@/NativeMobileWeb/useAndroidBackHandler'
import ShareLinkModal from './ShareLinkModal'
import SharedView from '@/Components/SharedView/SharedView'
import { decryptShare } from '@/Components/SharedView/shareCrypto'
import { buildSharedSuperFixture, SHARE_FIXTURE_MARKERS } from '@/Components/SharedView/sharedNoteFixture'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SHARE_ID = '002d6d3a-98e5-4e30-9765-36d8061f7843'

/** The markdown-ambiguous source: every character of it means something else to a markdown renderer. */
const AMBIGUOUS_SOURCE = '# NOT A HEADING\n\nplain **NOT BOLD** text\n    indented line'

const LEGACY_HTML = '<h1>REAL HEADING</h1><ul><li>REAL ITEM</li></ul>'

const CODE_SOURCE = 'function f() {\n    return 1\n}'

class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/**
 * A REAL `SNNote`, not a cast fake.
 *
 * `note.noteType` is not a plain field: `Note`'s constructor reads it off the
 * payload content and, when it is absent, consults the legacy
 * `prefersPlainEditor` app-data value. A `{ noteType } as SNNote` literal would
 * have skipped that entirely, and the "absent" cases below would have been
 * testing the fake rather than the note.
 */
let noteCounter = 0
const createNote = ({
  text,
  noteType,
  omitNoteType = false,
}: {
  text: string
  noteType?: NoteType
  omitNoteType?: boolean
}): SNNote =>
  new SNNote(
    new DecryptedPayload<NoteContent>(
      {
        uuid: `share-note-${noteCounter++}`,
        content_type: ContentType.TYPES.Note,
        content: FillItemContent<NoteContent>({
          title: 'SHARETITLE',
          text,
          ...(!omitNoteType && { noteType }),
        }),
        ...PayloadTimestampDefaults(),
      },
      PayloadSource.Constructor,
    ),
  )

type CreatedShare = { encryptedPayload: string; keyHex: string }

let producerContainer: HTMLElement
let producerRoot: Root
let viewerContainer: HTMLElement
let viewerRoot: Root | null
let originalAnimate: typeof Element.prototype.animate
let createShare: jest.Mock

const makeApp = () =>
  ({
    legacyApi: { createShare },
    // `createApplicationShareAssetSource` reads these lazily; none of the
    // fixtures below embeds a resolvable file, so the Super fixture's file nodes
    // become the peers' visible placeholders rather than silent omissions.
    items: { findItem: () => undefined },
    files: { downloadFile: async () => undefined },
    getPreference: (_key: unknown, defaultValue: unknown) => defaultValue,
    setPreference: () => Promise.resolve(),
    addEventObserver: () => () => undefined,
    addAndroidBackHandlerEventListener: () => () => undefined,
    setAndroidBackHandlerFallbackListener: () => undefined,
    addNativeMobileEventListener: () => () => undefined,
  }) as never

beforeAll(async () => {
  await sodium.ready
})

beforeEach(() => {
  createShare = jest.fn(async () => ({ status: 200, data: { shareId: SHARE_ID } }))
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = MockResizeObserver
  window.matchMedia = ((query: string) => ({
    matches: /prefers-reduced-motion/.test(query),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  originalAnimate = Element.prototype.animate
  Element.prototype.animate = function () {
    return {
      finished: Promise.resolve(),
      cancel: () => undefined,
      finish: () => undefined,
      currentTime: 0,
    } as unknown as Animation
  }
  // The modal reports whether the link ACTUALLY reached the clipboard; jsdom has
  // neither the Clipboard API nor `execCommand`, so one is provided rather than
  // letting the fallback throw inside the create path.
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async () => undefined },
  })
  ;(window as unknown as { defaultSyncServer?: string }).defaultSyncServer = 'http://127.0.0.1:3061'

  producerContainer = document.createElement('div')
  document.body.appendChild(producerContainer)
  producerRoot = createRoot(producerContainer)

  viewerContainer = document.createElement('div')
  document.body.appendChild(viewerContainer)
  viewerRoot = null
})

afterEach(async () => {
  await act(async () => {
    producerRoot.unmount()
    viewerRoot?.unmount()
  })
  producerContainer.remove()
  viewerContainer.remove()
  document.body.querySelectorAll('[data-dialog-portal]').forEach((element) => element.remove())
  Element.prototype.animate = originalAnimate
})

/**
 * Drive the REAL modal: mount it, press its own "Create link" button, and return
 * only what actually leaves the owner's machine — the envelope the API was
 * handed, and the fragment key as the modal printed it for the author to copy.
 */
const createShareLink = async (note: SNNote): Promise<CreatedShare> => {
  const application = makeApp()

  await act(async () => {
    producerRoot.render(
      createElement(ApplicationProvider, {
        application,
        children: createElement(AndroidBackHandlerProvider, {
          application,
          children: createElement(ShareLinkModal, { application, note, isOpen: true, close: () => undefined }),
        }),
      }),
    )
  })

  const createButton = Array.from(document.body.querySelectorAll('button')).find(
    (button) => (button.textContent || '').trim() === 'Create link',
  )
  expect(createButton).toBeDefined()

  await act(async () => {
    createButton?.click()
  })
  await act(async () => {
    await Promise.resolve()
  })

  expect(createShare).toHaveBeenCalledTimes(1)
  const encryptedPayload = (createShare.mock.calls[0][0] as { encryptedPayload: string }).encryptedPayload

  const link = Array.from(document.body.querySelectorAll('textarea'))
    .map((field) => (field as HTMLTextAreaElement).value)
    .find((value) => value.includes(`?shared=${SHARE_ID}#`))
  expect(link).toBeDefined()

  return { encryptedPayload, keyHex: (link as string).split('#')[1] }
}

/** What the server would hand an anonymous reader, wrapper and all. */
const stubGatewayFetch = (encryptedPayload: string) => {
  ;(globalThis as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
    status: 200,
    ok: true,
    json: async () => ({
      meta: { auth: {}, server: { filesServerUrl: 'http://127.0.0.1:3061/files' } },
      data: { type: 'note', encryptedPayload, oneTimeView: false, viewExpiresMinutes: null },
    }),
  }))
}

/** Mount the REAL public viewer on a REAL envelope and return its DOM. */
const readShareLink = async ({ encryptedPayload, keyHex }: CreatedShare): Promise<HTMLElement> => {
  stubGatewayFetch(encryptedPayload)
  window.history.replaceState(null, '', `/?shared=${SHARE_ID}#${keyHex}`)

  viewerRoot = createRoot(viewerContainer)
  await act(async () => {
    viewerRoot?.render(createElement(SharedView, { shareId: SHARE_ID }))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })

  return viewerContainer
}

/** The plaintext the reader's browser recovers — the only place `noteType` can be read. */
const envelopeContents = async ({ encryptedPayload, keyHex }: CreatedShare): Promise<Record<string, unknown>> =>
  (await decryptShare(encryptedPayload, keyHex)) as unknown as Record<string, unknown>

describe('the share envelope declares the note type', () => {
  it.each([
    [NoteType.Plain, 'plain-text'],
    [NoteType.Markdown, 'markdown'],
    [NoteType.RichText, 'rich-text'],
    [NoteType.Code, 'code'],
    [NoteType.Super, 'super'],
  ])('carries %s as the string %s, under the field name the viewer reads', async (noteType, expected) => {
    const share = await createShareLink(createNote({ text: AMBIGUOUS_SOURCE, noteType }))
    const contents = await envelopeContents(share)

    expect(Object.keys(contents)).toContain('noteType')
    expect(contents.noteType).toBe(expected)
  })

  it('omits the field entirely for a note that has no type, rather than writing a null', async () => {
    const share = await createShareLink(createNote({ text: AMBIGUOUS_SOURCE, omitNoteType: true }))
    const contents = await envelopeContents(share)

    expect('noteType' in contents).toBe(false)
    expect(contents).toEqual({ kind: 'note', title: 'SHARETITLE', text: AMBIGUOUS_SOURCE })
  })

  it('still carries the title and the asset-inlined text', async () => {
    const share = await createShareLink(createNote({ text: AMBIGUOUS_SOURCE, noteType: NoteType.Plain }))
    const contents = await envelopeContents(share)

    expect(contents.kind).toBe('note')
    expect(contents.title).toBe('SHARETITLE')
    expect(contents.text).toBe(AMBIGUOUS_SOURCE)
  })
})

describe('what the reader sees, per note type, end to end', () => {
  it('renders a plaintext note verbatim instead of interpreting it as markdown', async () => {
    const page = await readShareLink(
      await createShareLink(createNote({ text: AMBIGUOUS_SOURCE, noteType: NoteType.Plain })),
    )

    const block = page.querySelector('[data-shared-note-format="plain"]')
    expect(block).not.toBeNull()
    expect(block?.textContent).toContain('# NOT A HEADING')
    expect(block?.textContent).toContain('**NOT BOLD**')
    expect(block?.textContent).toContain('    indented line')
    // The author's `#` and `**` invented no structure...
    expect(page.querySelector('[data-shared-note-format="plain"] h1')).toBeNull()
    expect(page.querySelector('[data-shared-note-format="plain"] strong')).toBeNull()
    // ...and the only `h1` on the page is the share's own title.
    expect(Array.from(page.querySelectorAll('article h1')).map((element) => element.textContent)).toEqual([
      'SHARETITLE',
    ])
  })

  it('renders a markdown note as markdown', async () => {
    const page = await readShareLink(
      await createShareLink(createNote({ text: '# A HEADING\n\n- ITEM', noteType: NoteType.Markdown })),
    )

    expect(page.querySelector('[data-shared-note-format="markdown"]')).not.toBeNull()
    expect(page.querySelector('[data-shared-note-format="markdown"] h1')?.textContent).toContain('A HEADING')
    expect(page.querySelector('[data-shared-note-format="markdown"] li')?.textContent).toContain('ITEM')
  })

  it('renders a legacy rich-text note as markup instead of printing the markup', async () => {
    const page = await readShareLink(
      await createShareLink(createNote({ text: LEGACY_HTML, noteType: NoteType.RichText })),
    )

    const block = page.querySelector('[data-shared-note-format="html"]')
    expect(block).not.toBeNull()
    expect(block?.querySelector('h1')?.textContent).toBe('REAL HEADING')
    expect(block?.querySelector('li')?.textContent).toBe('REAL ITEM')
    expect(page.textContent).not.toContain('<h1>')
  })

  it('renders a code note verbatim in a preformatted block', async () => {
    const page = await readShareLink(await createShareLink(createNote({ text: CODE_SOURCE, noteType: NoteType.Code })))

    const block = page.querySelector('[data-shared-note-format="code"]')
    expect(block?.tagName).toBe('PRE')
    expect(block?.textContent).toBe(CODE_SOURCE)
  })

  it('renders a Super note through the real editor, not as JSON', async () => {
    const page = await readShareLink(
      await createShareLink(createNote({ text: buildSharedSuperFixture(), noteType: NoteType.Super })),
    )

    const text = page.textContent ?? ''
    // Scoped to the note body: the only other `h1` on the page is the share's
    // own title, which renders whatever the format resolution did.
    const body = page.querySelector('[data-shared-note-format="super"]')
    expect(body).not.toBeNull()
    expect(text).not.toContain('"root":{"children"')
    expect(text).not.toContain('"type":"paragraph"')
    expect(body?.querySelector('h1')?.textContent).toContain(SHARE_FIXTURE_MARKERS.heading)
    expect(body?.querySelector('h2')?.textContent).toContain(SHARE_FIXTURE_MARKERS.subheading)
    expect(body?.querySelectorAll('ul').length ?? 0).toBeGreaterThan(0)
    expect(body?.querySelectorAll('table').length ?? 0).toBeGreaterThan(0)
    expect(text).toContain(SHARE_FIXTURE_MARKERS.codeBlock)
  })
})

/**
 * EVERY LINK CREATED BEFORE THIS CHANGE. There are live share links in the world
 * whose envelope has no `noteType` at all, and the field must stay a
 * disambiguator rather than become a gate: a Super note is recognised from its
 * own bytes, and anything else keeps the markdown fallback it already had.
 */
describe('a link created before the field existed', () => {
  it('still renders a Super note through the real editor with no declared type', async () => {
    const share = await createShareLink(createNote({ text: buildSharedSuperFixture(), omitNoteType: true }))
    expect('noteType' in (await envelopeContents(share))).toBe(false)

    const page = await readShareLink(share)
    const text = page.textContent ?? ''
    const body = page.querySelector('[data-shared-note-format="super"]')

    expect(body).not.toBeNull()
    expect(text).not.toContain('"root":{"children"')
    expect(body?.querySelector('h1')?.textContent).toContain(SHARE_FIXTURE_MARKERS.heading)
    expect(body?.querySelectorAll('table').length ?? 0).toBeGreaterThan(0)
  })

  it('still shows a typeless plain note through the markdown fallback rather than failing', async () => {
    const share = await createShareLink(createNote({ text: AMBIGUOUS_SOURCE, omitNoteType: true }))

    const page = await readShareLink(share)

    // The pre-change behaviour, unchanged and NOT an error page.
    expect(page.querySelector('[data-shared-note-format="markdown"]')).not.toBeNull()
    expect(page.textContent).toContain('NOT A HEADING')
    expect(page.textContent).not.toContain('invalidLink')
  })
})
