/** @jest-environment jsdom */

import { readFileSync } from 'fs'
import { join } from 'path'
import { ElementIds } from '@/Constants/ElementIDs'
import {
  ContentType,
  createLitePayloadFromDecrypted,
  DecryptedPayload,
  DecryptedPayloadInterface,
  FillItemContent,
  NoteContent,
  NoteType,
  PayloadSource,
  PayloadTimestampDefaults,
  SNNote,
} from '@standardnotes/snjs'
import { SuperEditorContentId } from '@/Components/SuperEditor/Constants'
import { PRINT_BODY_ID, PRINT_LAYOUT_STYLE_ID } from '@/Components/SuperEditor/Layout/applyPrintLayout'
import { DEFAULT_NOTE_LAYOUT, saveNoteLayout } from '@/Components/SuperEditor/Layout/layoutSettings'
import {
  registerPrintableDataTable,
  unregisterPrintableDataTable,
} from '@/Components/SuperEditor/Lexical/Nodes/PrintableDataTableRegistry'
import {
  registerPrintableCalendar,
  unregisterPrintableCalendar,
} from '@/Components/SuperEditor/Lexical/Nodes/PrintableCalendarRegistry'
import { registerPrintableView, unregisterPrintableView } from './PrintableViewRegistry'
import {
  createPersistedPrintOptions,
  createPrintSnapshot,
  getActiveNotePrintSupport,
  installNativeNotePrinting,
  PRINT_EMPTY_ATTRIBUTE,
  PRINT_NOTE_UUID_ATTRIBUTE,
  PRINTING_BODY_CLASS,
  PRINT_ROOT_ID,
  PRINT_TITLE_ID,
  PersistedPrintEditorProof,
  printActiveNote,
  removePrintSnapshot,
  resolvePersistedPrintOptions,
} from './PrintNote'

const nativePlainEditor: PersistedPrintEditorProof = {
  isNativeFeature: true,
  isComponent: false,
  noteType: NoteType.Plain,
  featureIdentifier: 'com.standardnotes.plain-text',
}

const legacyCustomEditor: PersistedPrintEditorProof = {
  isNativeFeature: false,
  isComponent: true,
  noteType: NoteType.Plain,
  featureIdentifier: 'org.example.legacy-custom-editor',
}

const nativeSuperEditor: PersistedPrintEditorProof = {
  isNativeFeature: true,
  isComponent: false,
  noteType: NoteType.Super,
  featureIdentifier: 'com.standardnotes.super-editor',
}

let persistedPrintUuid = 0
const createFullPrintNote = ({
  uuid = `print-note-${persistedPrintUuid++}`,
  title = 'Document title',
  text = 'Complete document body',
  noteType = NoteType.Plain,
  editorIdentifier,
  omitNoteType = false,
}: {
  uuid?: string
  title?: string
  text?: string
  noteType?: NoteType
  editorIdentifier?: string
  omitNoteType?: boolean
} = {}): SNNote =>
  new SNNote(
    new DecryptedPayload<NoteContent>(
      {
        uuid,
        content_type: ContentType.TYPES.Note,
        content: FillItemContent<NoteContent>({
          title,
          text,
          ...(!omitNoteType && { noteType }),
          editorIdentifier,
        }),
        ...PayloadTimestampDefaults(),
      },
      PayloadSource.Constructor,
    ),
  )

const createLitePrintNote = (fullNote: SNNote): SNNote => new SNNote(createLitePayloadFromDecrypted(fullNote.payload))

const createDeferredPayload = () => {
  let resolve!: (payload: DecryptedPayloadInterface | undefined) => void
  const promise = new Promise<DecryptedPayloadInterface | undefined>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('isolated note printing', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    document.head.querySelector(`#${PRINT_LAYOUT_STYLE_ID}`)?.remove()
    localStorage.clear()
  })

  afterEach(() => {
    removePrintSnapshot()
    jest.restoreAllMocks()
  })

  it('rehydrates an unopened lazy plaintext note before exposing its title and body to print', async () => {
    const fullNote = createFullPrintNote({ title: 'Cold note', text: 'Body loaded from encrypted storage' })
    const liteNote = createLitePrintNote(fullNote)
    expect(liteNote.text).toBe('')
    expect(createPersistedPrintOptions(liteNote, nativePlainEditor)).toBeUndefined()

    const source = await resolvePersistedPrintOptions({
      noteUuid: liteNote.uuid,
      getSelectedNoteUuid: () => liteNote.uuid,
      findNote: () => liteNote,
      getFullContentPayload: jest.fn().mockResolvedValue(fullNote.payload),
      getEditorForNote: () => nativePlainEditor,
    })

    expect(source?.options.fallbackTitle).toBe('Cold note')
    expect(source?.options.fallbackBody).toBe('Body loaded from encrypted storage')
    const snapshot = source ? createPrintSnapshot(source.options) : undefined
    expect(snapshot?.querySelector(`#${PRINT_TITLE_ID}`)?.textContent).toBe('Cold note')
    expect(snapshot?.querySelector(`#${PRINT_BODY_ID}`)?.textContent).toBe('Body loaded from encrypted storage')
  })

  it('fails closed when lazy-note decryption fails', async () => {
    const liteNote = createLitePrintNote(createFullPrintNote())

    await expect(
      resolvePersistedPrintOptions({
        noteUuid: liteNote.uuid,
        getSelectedNoteUuid: () => liteNote.uuid,
        findNote: () => liteNote,
        getFullContentPayload: jest.fn().mockRejectedValue(new Error('Unable to decrypt payload')),
        getEditorForNote: () => nativePlainEditor,
      }),
    ).resolves.toBeUndefined()
  })

  it('fails closed when the note is deleted while its complete payload is loading', async () => {
    const fullNote = createFullPrintNote()
    const liteNote = createLitePrintNote(fullNote)
    const deferred = createDeferredPayload()
    let liveNote: SNNote | undefined = liteNote
    const pending = resolvePersistedPrintOptions({
      noteUuid: liteNote.uuid,
      getSelectedNoteUuid: () => liteNote.uuid,
      findNote: () => liveNote,
      getFullContentPayload: () => deferred.promise,
      getEditorForNote: () => nativePlainEditor,
    })

    liveNote = undefined
    deferred.resolve(fullNote.payload)

    await expect(pending).resolves.toBeUndefined()
  })

  it('prints a genuinely complete note whose body is intentionally empty', () => {
    const emptyNote = createFullPrintNote({ title: 'Empty on purpose', text: '' })
    const options = createPersistedPrintOptions(emptyNote, nativePlainEditor)

    expect(options?.fallbackBody).toBe('')
    expect(getActiveNotePrintSupport(options)).toEqual({ supported: true, source: 'fallback' })
    const snapshot = options ? createPrintSnapshot(options) : undefined
    expect(snapshot?.querySelector(`#${PRINT_TITLE_ID}`)?.textContent).toBe('Empty on purpose')
    expect(snapshot?.querySelector(`#${PRINT_BODY_ID}`)?.textContent).toBe('')
  })

  it('fails closed for a legacy-associated custom editor even when type and identifier are absent', async () => {
    const fullNote = createFullPrintNote({ omitNoteType: true })
    const liteNote = createLitePrintNote(fullNote)
    const getFullContentPayload = jest.fn().mockResolvedValue(fullNote.payload)

    expect(fullNote.payload.content.noteType).toBeUndefined()
    expect(fullNote.editorIdentifier).toBeUndefined()
    expect(createPersistedPrintOptions(fullNote, legacyCustomEditor)).toBeUndefined()
    await expect(
      resolvePersistedPrintOptions({
        noteUuid: liteNote.uuid,
        getSelectedNoteUuid: () => liteNote.uuid,
        findNote: () => liteNote,
        getFullContentPayload,
        getEditorForNote: () => legacyCustomEditor,
      }),
    ).resolves.toBeUndefined()
    expect(getFullContentPayload).not.toHaveBeenCalled()
  })

  it('fails closed when a plaintext note type resolves to a custom component editor', () => {
    const note = createFullPrintNote({
      noteType: NoteType.Markdown,
      editorIdentifier: 'org.example.custom-markdown-editor',
    })
    const customEditorWithNativeIdentifierCollision: PersistedPrintEditorProof = {
      isNativeFeature: true,
      isComponent: true,
      noteType: NoteType.Markdown,
      featureIdentifier: 'org.standardnotes.advanced-markdown-editor',
    }

    expect(createPersistedPrintOptions(note, customEditorWithNativeIdentifierCollision)).toBeUndefined()
  })

  it('fails closed when note selection changes during lazy-note loading', async () => {
    const fullNote = createFullPrintNote()
    const liteNote = createLitePrintNote(fullNote)
    const deferred = createDeferredPayload()
    let selectedNoteUuid: string | undefined = liteNote.uuid
    const pending = resolvePersistedPrintOptions({
      noteUuid: liteNote.uuid,
      getSelectedNoteUuid: () => selectedNoteUuid,
      findNote: () => liteNote,
      getFullContentPayload: () => deferred.promise,
      getEditorForNote: () => nativePlainEditor,
    })

    selectedNoteUuid = 'another-note'
    deferred.resolve(fullNote.payload)

    await expect(pending).resolves.toBeUndefined()
  })

  it('rejects a stale disk body when the live lite projection changes during loading', async () => {
    const originalFullNote = createFullPrintNote({ text: 'Stale disk body' })
    const originalLiteNote = createLitePrintNote(originalFullNote)
    const replacementLiteNote = createLitePrintNote(
      createFullPrintNote({ uuid: originalFullNote.uuid, title: 'New metadata', text: 'New body' }),
    )
    const deferred = createDeferredPayload()
    let liveNote = originalLiteNote
    const pending = resolvePersistedPrintOptions({
      noteUuid: originalLiteNote.uuid,
      getSelectedNoteUuid: () => originalLiteNote.uuid,
      findNote: () => liveNote,
      getFullContentPayload: () => deferred.promise,
      getEditorForNote: () => nativePlainEditor,
    })

    liveNote = replacementLiteNote
    deferred.resolve(originalFullNote.payload)

    await expect(pending).resolves.toBeUndefined()
  })

  it('rejects a full payload whose resolved format disagrees with the live lite projection', async () => {
    const livePlainNote = createFullPrintNote({ text: 'Expected plaintext' })
    const liteNote = createLitePrintNote(livePlainNote)
    const mismatchedSuperNote = createFullPrintNote({
      uuid: livePlainNote.uuid,
      noteType: NoteType.Super,
      text: '{"root":{"type":"root","children":[]}}',
    })

    await expect(
      resolvePersistedPrintOptions({
        noteUuid: liteNote.uuid,
        getSelectedNoteUuid: () => liteNote.uuid,
        findNote: () => liteNote,
        getFullContentPayload: async () => mismatchedSuperNote.payload,
        getEditorForNote: (note) => (note.noteType === NoteType.Super ? nativeSuperEditor : nativePlainEditor),
      }),
    ).resolves.toBeUndefined()
  })

  it('keeps print CSS default-deny even before runtime can resolve a note', () => {
    const stylesheet = readFileSync(join(__dirname, '../../../../stylesheets/_print.scss'), 'utf8')

    expect(stylesheet).toContain('html body > *:not(#srn-print-root)')
    expect(stylesheet).toMatch(/html body > \*:not\(#srn-print-root\)\s*\{[^}]*display: none !important;/s)
    expect(stylesheet).toMatch(/html body > \*:not\(#srn-print-root\)\s*\{[^}]*visibility: hidden !important;/s)
    expect(stylesheet).toMatch(/html body > #srn-print-root\s*\{[^}]*display: block !important;/s)
    expect(stylesheet).not.toContain('body.srn-printing > *:not(#srn-print-root)')
  })

  it('builds exactly an unsaved title and sanitized Super-note body, with no UI nodes or forbidden copy', () => {
    document.body.innerHTML = `
      <div id="application-chrome">
        <button>Global toolbar</button>
        <input id="${ElementIds.NoteTitleEditor}" ${PRINT_NOTE_UUID_ATTRIBUTE}="active-note" value="Saved title" />
        <div id="${SuperEditorContentId}" contenteditable="true">
          <p>Current unsaved body</p>
          <button>Add row</button>
          <div role="toolbar">Formatting toolbar</div>
          <div role="menu">Widget menu</div>
          <div class="ContentEditable__placeholder">Type / for commands</div>
          <div class="attachment-toolbar">Save attachment</div>
          <input type="search" placeholder="Search rows" value="private filter" />
          <input aria-label="Board title" value="Roadmap" />
          <label>Done <input type="checkbox" checked /></label>
          <table><tbody><tr><td>Preserved table cell</td></tr></tbody></table>
          <img src="data:image/png;base64,AA==" alt="Preserved diagram" />
          <script>window.bad = true</script>
        </div>
        <div>Presence: Alice</div>
      </div>
    `
    ;(document.getElementById(ElementIds.NoteTitleEditor) as HTMLInputElement).value = 'Current unsaved title'
    ;(document.querySelector('[aria-label="Board title"]') as HTMLInputElement).value = 'Current roadmap title'

    const snapshot = createPrintSnapshot({
      noteUuid: 'active-note',
      fallbackTitle: 'Stale persisted title',
      fallbackBody: 'Stale persisted body',
    })
    expect(snapshot).toBeDefined()
    if (!snapshot) {
      throw new Error('Expected a printable Super note')
    }

    expect(snapshot.id).toBe(PRINT_ROOT_ID)
    expect(Array.from(snapshot.children).map((child) => child.id)).toEqual([PRINT_TITLE_ID, PRINT_BODY_ID])
    expect(snapshot.querySelector(`#${PRINT_TITLE_ID}`)?.textContent).toBe('Current unsaved title')
    expect(snapshot.textContent).toContain('Current unsaved body')
    expect(snapshot.textContent).not.toContain('Stale persisted body')
    expect(snapshot.textContent).toContain('Current roadmap title')
    expect(snapshot.textContent).toContain('Preserved table cell')
    expect(snapshot.querySelector('table')).not.toBeNull()
    expect(snapshot.querySelector('img[alt="Preserved diagram"]')).not.toBeNull()
    expect(snapshot.querySelector('.srn-print-checkbox')?.textContent).toBe('☒')

    expect(
      snapshot.querySelector(
        'button, input, textarea, select, script, iframe, object, video, audio, [role="button"], [role="menu"], [role="toolbar"]',
      ),
    ).toBeNull()
    for (const forbiddenText of [
      'Global toolbar',
      'Add row',
      'Formatting toolbar',
      'Widget menu',
      'Type / for commands',
      'Save attachment',
      'private filter',
      'Presence: Alice',
    ]) {
      expect(snapshot.textContent).not.toContain(forbiddenText)
    }
  })

  it('keeps explicitly projected document labels as inert body text and removes decorator prompts', () => {
    document.body.innerHTML = `
      <input id="${ElementIds.NoteTitleEditor}" value="Structured note" />
      <div id="${SuperEditorContentId}">
        <p>Semantic paragraph</p>
        <div data-srn-print-exclude="true">Add a task to render the chart.</div>
        <div data-srn-print-exclude="true">No items yet. Use + Item to add one.</div>
        <ul>
          <li><button data-srn-print-static-text="true">First heading</button></li>
        </ul>
        <p>
          Body with a footnote
          <sup role="button" tabindex="0" data-srn-print-static-text="true">[1]</sup>
          and <span role="button" tabindex="0" data-srn-print-static-text="true"><em>x²</em></span>.
        </p>
        <button>Add card</button>
      </div>
    `

    const snapshot = createPrintSnapshot()

    expect(snapshot?.textContent).toContain('Semantic paragraph')
    expect(snapshot?.textContent).toContain('First heading')
    expect(snapshot?.textContent).toContain('[1]')
    expect(snapshot?.querySelector('em')?.textContent).toBe('x²')
    expect(snapshot?.textContent).not.toContain('Add a task')
    expect(snapshot?.textContent).not.toContain('No items yet')
    expect(snapshot?.textContent).not.toContain('Add card')
    expect(snapshot?.querySelector('button, [role="button"], [data-srn-print-exclude]')).toBeNull()
  })

  it('prints the live plain-text value rather than a stale value attribute', () => {
    document.body.innerHTML = `
      <input id="${ElementIds.NoteTitleEditor}" value="Title" />
      <textarea id="${ElementIds.NoteTextEditor}">stale body</textarea>
    `
    ;(document.getElementById(ElementIds.NoteTextEditor) as HTMLTextAreaElement).value = 'latest unsaved body'

    const snapshot = createPrintSnapshot()
    expect(snapshot).toBeDefined()
    if (!snapshot) {
      throw new Error('Expected a printable plain note')
    }

    expect(snapshot.querySelector(`#${PRINT_BODY_ID}`)?.textContent).toBe('latest unsaved body')
    expect(snapshot.querySelector('textarea')).toBeNull()
  })

  it('attaches only the snapshot for printing, applies layout to it, and cleans up on afterprint', () => {
    document.body.innerHTML = `
      <main id="live-app">
        <input id="${ElementIds.NoteTitleEditor}" ${PRINT_NOTE_UUID_ATTRIBUTE}="note-1" value="Title" />
        <div id="${SuperEditorContentId}"><p>Body</p></div>
      </main>
    `
    const print = jest.spyOn(window, 'print').mockImplementation(() => undefined)
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    saveNoteLayout('note-1', { ...DEFAULT_NOTE_LAYOUT, columns: 2 })

    printActiveNote({ noteUuid: 'note-1' })

    expect(print).toHaveBeenCalledTimes(1)
    expect(document.body.classList.contains(PRINTING_BODY_CLASS)).toBe(true)
    expect(document.body.children).toHaveLength(2)
    expect(document.body.lastElementChild?.id).toBe(PRINT_ROOT_ID)
    expect(document.getElementById(PRINT_LAYOUT_STYLE_ID)?.textContent).toContain(`#${PRINT_BODY_ID}`)

    window.dispatchEvent(new Event('afterprint'))

    expect(document.getElementById(PRINT_ROOT_ID)).toBeNull()
    expect(document.getElementById(PRINT_LAYOUT_STYLE_ID)).toBeNull()
    expect(document.body.classList.contains(PRINTING_BODY_CLASS)).toBe(false)
    expect(document.getElementById('live-app')).not.toBeNull()
  })

  it('cancels a superseded explicit print before its deferred window.print call', () => {
    document.body.innerHTML = `
      <input id="${ElementIds.NoteTitleEditor}" ${PRINT_NOTE_UUID_ATTRIBUTE}="note-1" value="First title" />
      <textarea id="${ElementIds.NoteTextEditor}">First body</textarea>
    `
    const print = jest.spyOn(window, 'print').mockImplementation(() => undefined)
    const frameCallbacks: FrameRequestCallback[] = []
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
      frameCallbacks.push(callback)
      return frameCallbacks.length
    })

    printActiveNote({ noteUuid: 'note-1' })

    const title = document.getElementById(ElementIds.NoteTitleEditor) as HTMLInputElement
    const body = document.getElementById(ElementIds.NoteTextEditor) as HTMLTextAreaElement
    title.setAttribute(PRINT_NOTE_UUID_ATTRIBUTE, 'note-2')
    title.value = 'Second title'
    body.value = 'Second body'
    printActiveNote({ noteUuid: 'note-2' })

    const firstAnimationFrame = frameCallbacks.splice(0)
    firstAnimationFrame.forEach((callback) => callback(0))
    const secondAnimationFrame = frameCallbacks.splice(0)
    secondAnimationFrame.forEach((callback) => callback(0))

    expect(print).toHaveBeenCalledTimes(1)
    expect(document.querySelector(`#${PRINT_TITLE_ID}`)?.textContent).toBe('Second title')
    expect(document.querySelector(`#${PRINT_BODY_ID}`)?.textContent).toBe('Second body')

    window.dispatchEvent(new Event('afterprint'))
  })

  it('replaces a paginated Super DataTable with its complete semantic all-row projection', () => {
    document.body.innerHTML = `
      <input id="${ElementIds.NoteTitleEditor}" value="Inventory" />
      <div id="${SuperEditorContentId}">
        <p>Before table</p>
        <div data-datatable-block="true">
          <div role="toolbar">Search and add controls</div>
          <table aria-label="Current page"><tbody><tr><td><button>Only visible row</button></td></tr></tbody></table>
          <div>1 / 3</div>
        </div>
        <p>After table</p>
      </div>
    `

    const liveDataTable = document.querySelector<HTMLElement>('[data-datatable-block="true"]')
    if (!liveDataTable) {
      throw new Error('Expected a live DataTable')
    }
    registerPrintableDataTable(liveDataTable, () => ({
      columns: ['Name', 'Count'],
      rows: [
        ['Alpha', '1'],
        ['Beta', '2'],
        ['Gamma', '3'],
      ],
    }))

    const snapshot = createPrintSnapshot()
    expect(snapshot).toBeDefined()
    if (!snapshot) {
      throw new Error('Expected a printable Super note')
    }

    const table = snapshot.querySelector('[data-srn-print-datatable="true"]')
    expect(table?.classList.contains('hidden')).toBe(false)
    expect(table?.hasAttribute('aria-hidden')).toBe(false)
    expect(table?.querySelectorAll('tbody tr')).toHaveLength(3)
    expect(table?.textContent).toContain('Alpha')
    expect(table?.textContent).toContain('Beta')
    expect(table?.textContent).toContain('Gamma')
    expect(snapshot.textContent).toContain('Before table')
    expect(snapshot.textContent).toContain('After table')
    expect(snapshot.textContent).not.toContain('Only visible row')
    expect(snapshot.textContent).not.toContain('Search and add controls')
    expect(snapshot.textContent).not.toContain('1 / 3')
    expect(snapshot.querySelector('button, [role="toolbar"]')).toBeNull()
    unregisterPrintableDataTable(liveDataTable)
  })

  it('prints folded Super content expanded without fold toggles or ellipsis state', () => {
    document.body.innerHTML = `
      <input id="${ElementIds.NoteTitleEditor}" value="Folded document" />
      <div id="${SuperEditorContentId}">
        <h2 class="Lexical__foldable Lexical__foldCollapsed">
          Folded heading
          <span class="Lexical__foldToggle" data-fold-toggle="true" role="button">Toggle fold</span>
        </h2>
        <p class="Lexical__folded hidden" hidden aria-hidden="true" style="display: none">Complete hidden paragraph</p>
      </div>
    `

    const snapshot = createPrintSnapshot()
    expect(snapshot?.textContent).toContain('Folded heading')
    expect(snapshot?.textContent).toContain('Complete hidden paragraph')
    expect(snapshot?.textContent).not.toContain('Toggle fold')
    expect(snapshot?.querySelector('[data-fold-toggle], .Lexical__foldToggle')).toBeNull()
    expect(snapshot?.querySelector('.Lexical__folded, .Lexical__foldCollapsed, .Lexical__foldable')).toBeNull()
    const restored = Array.from(snapshot?.querySelectorAll('p') ?? []).find((element) =>
      element.textContent?.includes('Complete hidden paragraph'),
    )
    expect(restored?.hasAttribute('hidden')).toBe(false)
    expect(restored?.getAttribute('aria-hidden')).toBeNull()
    expect(restored?.style.display).toBe('')

    // Snapshot normalization must not expand or otherwise mutate the live editor.
    expect(document.querySelector('.Lexical__foldCollapsed')).not.toBeNull()
    expect(document.querySelector('.Lexical__folded')?.hasAttribute('hidden')).toBe(true)
  })

  it('replaces a Super Calendar with all persisted events without changing its selected day or month UI', () => {
    document.body.innerHTML = `
      <input id="${ElementIds.NoteTitleEditor}" value="Schedule" />
      <div id="${SuperEditorContentId}">
        <p>Before calendar</p>
        <div data-calendar-block="true" data-selected-day="2026-08-11" data-visible-month="2026-08">
          <button>Previous month</button>
          <button aria-pressed="true">Selected day 11</button>
          <div>Only selected event</div>
          <input placeholder="Add an event" value="Pending UI text" />
        </div>
        <p>After calendar</p>
      </div>
    `
    const liveCalendar = document.querySelector<HTMLElement>('[data-calendar-block="true"]')
    if (!liveCalendar) {
      throw new Error('Expected a live Calendar')
    }
    const liveMarkup = liveCalendar.innerHTML
    registerPrintableCalendar(liveCalendar, () => ({
      events: [
        { date: '2026-07-30', text: 'Off-month planning' },
        { date: '2026-08-11', text: 'Selected meeting' },
        { date: '2026-09-02', text: 'Future launch' },
      ],
    }))

    const snapshot = createPrintSnapshot()
    const calendar = snapshot?.querySelector('[data-srn-print-calendar="true"]')
    expect(calendar?.querySelectorAll('tbody tr')).toHaveLength(3)
    expect(calendar?.textContent).toContain('2026-07-30')
    expect(calendar?.textContent).toContain('Off-month planning')
    expect(calendar?.textContent).toContain('Selected meeting')
    expect(calendar?.textContent).toContain('2026-09-02')
    expect(calendar?.textContent).toContain('Future launch')
    expect(snapshot?.textContent).toContain('Before calendar')
    expect(snapshot?.textContent).toContain('After calendar')
    expect(snapshot?.textContent).not.toContain('Previous month')
    expect(snapshot?.textContent).not.toContain('Selected day 11')
    expect(snapshot?.textContent).not.toContain('Only selected event')
    expect(snapshot?.querySelector('button, input')).toBeNull()
    expect(liveCalendar.innerHTML).toBe(liveMarkup)
    expect(liveCalendar.dataset.selectedDay).toBe('2026-08-11')
    expect(liveCalendar.dataset.visibleMonth).toBe('2026-08')
    unregisterPrintableCalendar(liveCalendar)
  })

  it('prints an inactive context-menu note from its persisted title/body without mixing active live DOM', () => {
    document.body.innerHTML = `
      <input id="${ElementIds.NoteTitleEditor}" ${PRINT_NOTE_UUID_ATTRIBUTE}="active-note" value="Unsaved active title" />
      <div id="${SuperEditorContentId}"><p>Unsaved active body</p></div>
    `
    const options = {
      noteUuid: 'inactive-note',
      fallbackTitle: 'Persisted selected title',
      fallbackBody: 'Persisted selected body',
      fallbackNoteType: NoteType.Plain,
      fallbackSource: 'verified-native-plaintext' as const,
    }

    expect(getActiveNotePrintSupport(options)).toEqual({ supported: true, source: 'fallback' })
    const snapshot = createPrintSnapshot(options)

    expect(snapshot?.querySelector(`#${PRINT_TITLE_ID}`)?.textContent).toBe('Persisted selected title')
    expect(snapshot?.querySelector(`#${PRINT_BODY_ID}`)?.textContent).toBe('Persisted selected body')
    expect(snapshot?.textContent).not.toContain('Unsaved active title')
    expect(snapshot?.textContent).not.toContain('Unsaved active body')
  })

  it('fails inactive Super notes closed instead of printing real Lexical JSON serialization', () => {
    document.body.innerHTML = `
      <input id="${ElementIds.NoteTitleEditor}" ${PRINT_NOTE_UUID_ATTRIBUTE}="active-note" value="Active title" />
      <div id="${SuperEditorContentId}"><p>Active body</p></div>
    `
    const lexicalBody = JSON.stringify({
      root: {
        children: [
          {
            children: [
              {
                detail: 0,
                format: 0,
                mode: 'normal',
                style: '',
                text: 'First persisted paragraph',
                type: 'text',
                version: 1,
              },
            ],
            direction: 'ltr',
            format: '',
            indent: 0,
            type: 'paragraph',
            version: 1,
          },
          {
            children: [
              {
                detail: 0,
                format: 0,
                mode: 'normal',
                style: '',
                text: 'Second persisted paragraph',
                type: 'text',
                version: 1,
              },
            ],
            direction: 'ltr',
            format: '',
            indent: 0,
            type: 'paragraph',
            version: 1,
          },
        ],
        direction: 'ltr',
        format: '',
        indent: 0,
        type: 'root',
        version: 1,
      },
    })
    const options = {
      noteUuid: 'inactive-super',
      fallbackTitle: 'Persisted Super title',
      fallbackBody: lexicalBody,
      fallbackNoteType: NoteType.Super,
    }

    const print = jest.spyOn(window, 'print').mockImplementation(() => undefined)

    expect(getActiveNotePrintSupport(options)).toEqual({
      supported: false,
      reason: 'This note needs a complete persisted title and body before it can print.',
    })
    expect(createPrintSnapshot(options)).toBeUndefined()
    expect(printActiveNote(options)).toBeUndefined()
    expect(document.getElementById(PRINT_ROOT_ID)).toBeNull()
    expect(print).not.toHaveBeenCalled()
  })

  it('has a fail-closed support predicate and never emits a title-only snapshot for custom editors', () => {
    document.body.innerHTML = `
      <input id="${ElementIds.NoteTitleEditor}" ${PRINT_NOTE_UUID_ATTRIBUTE}="custom-1" value="Custom" />
      <div id="${ElementIds.EditorContent}"><iframe title="Custom editor"></iframe></div>
    `
    const print = jest.spyOn(window, 'print').mockImplementation(() => undefined)

    expect(getActiveNotePrintSupport({ noteUuid: 'another-note' })).toEqual({
      supported: false,
      reason: 'This note needs a complete persisted title and body before it can print.',
    })
    const structuredCustomOptions = {
      noteUuid: 'custom-1',
      fallbackTitle: 'Custom',
      fallbackBody: '{"cards":[{"title":"Persisted card"}]}',
      fallbackNoteType: NoteType.Unknown,
      fallbackEditorIdentifier: 'org.third.party.cards',
    }
    expect(getActiveNotePrintSupport(structuredCustomOptions)).toEqual({
      supported: false,
      reason: 'This editor cannot provide a safe title-and-body print view.',
    })
    expect(createPrintSnapshot(structuredCustomOptions)).toBeUndefined()
    expect(printActiveNote(structuredCustomOptions)).toBeUndefined()
    expect(print).not.toHaveBeenCalled()
    expect(document.getElementById(PRINT_ROOT_ID)).toBeNull()
    expect(document.body.textContent).not.toContain('Persisted card')
  })

  it('uses persisted text only after a bundled plaintext editor has been authoritatively verified', () => {
    document.body.innerHTML = `
      <main id="custom-editor-chrome">
        <input id="${ElementIds.NoteTitleEditor}" ${PRINT_NOTE_UUID_ATTRIBUTE}="custom-native" value="Live custom title" />
        <div id="${ElementIds.EditorContent}">
          <button>Add card</button>
          <div role="toolbar">Custom toolbar</div>
          <iframe title="Untrusted custom editor"></iframe>
        </div>
      </main>
    `
    const fallbackBody = '# Complete persisted heading\n\nComplete persisted body'
    const options = {
      noteUuid: 'custom-native',
      fallbackBody,
      fallbackNoteType: NoteType.Markdown,
      fallbackEditorIdentifier: 'org.standardnotes.advanced-markdown',
      fallbackSource: 'verified-native-plaintext' as const,
    }
    const dispose = installNativeNotePrinting(() => options)

    expect(getActiveNotePrintSupport(options)).toEqual({
      supported: true,
      source: 'fallback',
    })

    window.dispatchEvent(new Event('beforeprint'))

    const snapshot = document.getElementById(PRINT_ROOT_ID)
    expect(snapshot?.querySelector(`#${PRINT_TITLE_ID}`)?.textContent).toBe('Live custom title')
    expect(snapshot?.querySelector(`#${PRINT_BODY_ID}`)?.textContent).toBe(fallbackBody)
    expect(snapshot?.querySelector('button, iframe, [role="toolbar"]')).toBeNull()
    expect(snapshot?.textContent).not.toContain('Add card')
    expect(snapshot?.textContent).not.toContain('Custom toolbar')
    expect(document.body.classList.contains(PRINTING_BODY_CLASS)).toBe(true)

    window.dispatchEvent(new Event('afterprint'))
    expect(document.getElementById(PRINT_ROOT_ID)).toBeNull()
    dispose()
  })

  it.each([
    {
      label: 'provider failure',
      provider: () => {
        throw new Error('transient item lookup failure')
      },
      reason: 'Printing could not safely read the active note.',
    },
    {
      label: 'unsupported provider result',
      provider: () => ({ noteUuid: 'missing-note' }),
      reason: 'This note needs a complete persisted title and body before it can print.',
    },
    {
      label: 'transiently absent note',
      provider: () => undefined,
      reason: 'This editor cannot provide a safe title-and-body print view.',
    },
  ])('fails browser-menu beforeprint closed for $label', ({ provider, reason }) => {
    document.body.innerHTML = `
      <main id="sensitive-app-chrome">
        <input id="${ElementIds.NoteTitleEditor}" ${PRINT_NOTE_UUID_ATTRIBUTE}="active-custom" value="Active title" />
        <button>Delete everything</button>
        <div role="toolbar">Private controls</div>
        <iframe title="Custom editor"></iframe>
      </main>
    `
    const unsupported = jest.fn()
    const dispose = installNativeNotePrinting(provider, unsupported)

    expect(() => window.dispatchEvent(new Event('beforeprint'))).not.toThrow()

    const snapshot = document.getElementById(PRINT_ROOT_ID)
    expect(snapshot?.getAttribute(PRINT_EMPTY_ATTRIBUTE)).toBe('true')
    expect(snapshot?.textContent).toBe('')
    expect(snapshot?.querySelector('button, iframe, [role="toolbar"]')).toBeNull()
    expect(document.body.classList.contains(PRINTING_BODY_CLASS)).toBe(true)
    expect(unsupported).toHaveBeenCalledWith(reason)

    window.dispatchEvent(new Event('afterprint'))
    expect(document.getElementById(PRINT_ROOT_ID)).toBeNull()
    expect(document.body.classList.contains(PRINTING_BODY_CLASS)).toBe(false)
    dispose()
  })

  it('still refuses in words when neither a note nor a printable view is on screen', () => {
    // The printable-view registry must not turn "nothing to print" into a
    // silent blank page: with no note editor AND nothing registered, the
    // refusal stays explicit and the compositor still gets the empty snapshot
    // rather than application chrome.
    document.body.innerHTML = '<main id="some-other-view"><button>Not a note</button></main>'
    const unsupported = jest.fn()
    const dispose = installNativeNotePrinting(() => ({}), unsupported)

    expect(getActiveNotePrintSupport({})).toEqual({
      supported: false,
      reason: 'Open a note or a printable view before printing.',
    })

    expect(() => window.dispatchEvent(new Event('beforeprint'))).not.toThrow()
    expect(unsupported).toHaveBeenCalledWith('Open a note or a printable view before printing.')
    expect(document.getElementById(PRINT_ROOT_ID)?.getAttribute(PRINT_EMPTY_ATTRIBUTE)).toBe('true')
    dispose()
  })

  it('never serves a projection from a view that is no longer on screen', () => {
    document.body.innerHTML = '<main id="view-host"></main>'
    const host = document.getElementById('view-host') as HTMLElement
    const viewRoot = document.createElement('div')
    host.appendChild(viewRoot)

    const body = document.createElement('div')
    body.textContent = 'Rows from a view the user has navigated away from'
    registerPrintableView(viewRoot, () => ({ title: 'Some view', body }))

    expect(getActiveNotePrintSupport({})).toEqual({ supported: true, source: 'view' })

    // Torn out WITHOUT deregistering — the failure mode a lifecycle bug leaves
    // behind. A stale projection must not decide what the browser prints.
    viewRoot.remove()
    expect(getActiveNotePrintSupport({})).toEqual({
      supported: false,
      reason: 'Open a note or a printable view before printing.',
    })
    expect(createPrintSnapshot({})).toBeUndefined()

    unregisterPrintableView(viewRoot)
  })

  it('asks the view for its content at print time, not at registration time', () => {
    document.body.innerHTML = '<main id="view-host"></main>'
    const host = document.getElementById('view-host') as HTMLElement
    const viewRoot = document.createElement('div')
    host.appendChild(viewRoot)

    // What the view is showing changes after it registers — a filter being
    // applied. A registry holding a materialised snapshot would print the old
    // set, so it must hold a getter and call it now.
    let currentRows = ['Everything', 'Both of them']
    registerPrintableView(viewRoot, () => {
      const body = document.createElement('div')
      currentRows.forEach((text) => {
        const row = document.createElement('p')
        row.textContent = text
        body.appendChild(row)
      })
      return { title: 'Some view', body }
    })

    expect(createPrintSnapshot({})?.textContent).toContain('Both of them')

    currentRows = ['Everything']
    const afterFilter = createPrintSnapshot({})
    expect(afterFilter?.textContent).toContain('Everything')
    expect(afterFilter?.textContent).not.toContain('Both of them')

    unregisterPrintableView(viewRoot)
  })

  it('keeps an inactive context-menu snapshot for the explicit print beforeprint event', () => {
    document.body.innerHTML = `
      <input id="${ElementIds.NoteTitleEditor}" ${PRINT_NOTE_UUID_ATTRIBUTE}="active-note" value="Active title" />
      <textarea id="${ElementIds.NoteTextEditor}">Active body</textarea>
    `
    const dispose = installNativeNotePrinting()
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    const print = jest.spyOn(window, 'print').mockImplementation(() => {
      window.dispatchEvent(new Event('beforeprint'))
    })

    printActiveNote({
      noteUuid: 'inactive-note',
      fallbackTitle: 'Inactive title',
      fallbackBody: 'Inactive body',
      fallbackNoteType: NoteType.Plain,
      fallbackSource: 'verified-native-plaintext',
    })

    expect(print).toHaveBeenCalledTimes(1)
    expect(document.querySelector(`#${PRINT_TITLE_ID}`)?.textContent).toBe('Inactive title')
    expect(document.querySelector(`#${PRINT_BODY_ID}`)?.textContent).toBe('Inactive body')
    expect(document.getElementById(PRINT_ROOT_ID)?.textContent).not.toContain('Active body')

    window.dispatchEvent(new Event('afterprint'))
    dispose()
  })

  it('rebuilds a stale explicit snapshot for a later native print when afterprint was omitted', () => {
    document.body.innerHTML = `
      <input id="${ElementIds.NoteTitleEditor}" ${PRINT_NOTE_UUID_ATTRIBUTE}="note-1" value="First title" />
      <textarea id="${ElementIds.NoteTextEditor}">First body</textarea>
    `
    const dispose = installNativeNotePrinting()
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    jest.spyOn(window, 'print').mockImplementation(() => undefined)

    printActiveNote({ noteUuid: 'note-1' })
    expect(document.querySelector(`#${PRINT_TITLE_ID}`)?.textContent).toBe('First title')

    const title = document.getElementById(ElementIds.NoteTitleEditor) as HTMLInputElement
    const body = document.getElementById(ElementIds.NoteTextEditor) as HTMLTextAreaElement
    title.setAttribute(PRINT_NOTE_UUID_ATTRIBUTE, 'note-2')
    title.value = 'Second title'
    body.value = 'Second body'

    window.dispatchEvent(new Event('beforeprint'))

    expect(document.querySelector(`#${PRINT_TITLE_ID}`)?.textContent).toBe('Second title')
    expect(document.querySelector(`#${PRINT_BODY_ID}`)?.textContent).toBe('Second body')
    expect(document.getElementById(PRINT_ROOT_ID)?.textContent).not.toContain('First body')

    window.dispatchEvent(new Event('afterprint'))
    dispose()
  })

  it('prepares the same isolated snapshot synchronously for browser-menu beforeprint and cleans it after print', () => {
    document.body.innerHTML = `
      <main id="live-app">
        <input id="${ElementIds.NoteTitleEditor}" ${PRINT_NOTE_UUID_ATTRIBUTE}="note-native" value="Live title" />
        <textarea id="${ElementIds.NoteTextEditor}">Saved body</textarea>
        <button>Add stuff</button>
      </main>
    `
    ;(document.getElementById(ElementIds.NoteTextEditor) as HTMLTextAreaElement).value = 'Latest unsaved body'
    const dispose = installNativeNotePrinting()

    window.dispatchEvent(new Event('beforeprint'))

    const snapshot = document.getElementById(PRINT_ROOT_ID)
    expect(snapshot?.querySelector(`#${PRINT_TITLE_ID}`)?.textContent).toBe('Live title')
    expect(snapshot?.querySelector(`#${PRINT_BODY_ID}`)?.textContent).toBe('Latest unsaved body')
    expect(snapshot?.textContent).not.toContain('Add stuff')
    expect(document.body.classList.contains(PRINTING_BODY_CLASS)).toBe(true)

    window.dispatchEvent(new Event('afterprint'))
    expect(document.getElementById(PRINT_ROOT_ID)).toBeNull()
    expect(document.body.classList.contains(PRINTING_BODY_CLASS)).toBe(false)

    dispose()
  })

  it('intercepts Ctrl/Cmd+P only for active notes and blocks unsupported editors with a tested reason', () => {
    document.body.innerHTML = `
      <input id="${ElementIds.NoteTitleEditor}" ${PRINT_NOTE_UUID_ATTRIBUTE}="note-shortcut" value="Title" />
      <textarea id="${ElementIds.NoteTextEditor}">Body</textarea>
    `
    const print = jest.spyOn(window, 'print').mockImplementation(() => undefined)
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    const unsupported = jest.fn()
    const dispose = installNativeNotePrinting(undefined, unsupported)
    const shortcut = new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true, cancelable: true })

    window.dispatchEvent(shortcut)

    expect(shortcut.defaultPrevented).toBe(true)
    expect(print).toHaveBeenCalledTimes(1)
    expect(unsupported).not.toHaveBeenCalled()
    window.dispatchEvent(new Event('afterprint'))

    document.getElementById(ElementIds.NoteTextEditor)?.remove()
    document.getElementById(ElementIds.EditorContent)?.remove()
    const unsupportedShortcut = new KeyboardEvent('keydown', {
      key: 'p',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    })
    window.dispatchEvent(unsupportedShortcut)

    expect(unsupportedShortcut.defaultPrevented).toBe(true)
    expect(print).toHaveBeenCalledTimes(1)
    expect(unsupported).toHaveBeenCalledWith('This editor cannot provide a safe title-and-body print view.')
    expect(document.getElementById(PRINT_ROOT_ID)).toBeNull()

    dispose()
  })
})
