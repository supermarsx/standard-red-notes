import { act } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { WebApplication } from '@/Application/WebApplication'
import { NoteViewController } from '../Controller/NoteViewController'
import { CUSTOM_EDITOR_PERSIST_DEBOUNCE_MS } from '../useEditorPersistenceDebounce'
import {
  CalendarDocument,
  CalendarEvent,
  parseCalendarDocument,
  serializeCalendarDocument,
  todayIso,
} from './CalendarDocument'
import { CalendarEditor } from './CalendarEditor'

jest.mock('@/Components/Icon/Icon', () => ({
  __esModule: true,
  default: () => <span aria-hidden="true" />,
}))

/**
 * The emit sources a note change can carry, as `@standardnotes/models` numbers
 * them. The editor must not care which one it is given; the tests name them so
 * that a reader can see a LOCAL change is among the ones exercised.
 */
const LOCAL_CHANGED = 2
const REMOTE_RETRIEVED = 11

type NoteObserver = (note: { uuid: string; text: string; locked: boolean }, source: number) => void

const today = todayIso()

const calendar = (events: CalendarEvent[]): CalendarDocument => ({ version: 1, events })
const event = (id: string, title: string): CalendarEvent => ({ id, date: today, title })

describe('CalendarEditor and a note that changes underneath it', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    jest.useFakeTimers()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    jest.useRealTimers()
  })

  const mount = (initial: CalendarDocument, options: { locked?: boolean } = {}) => {
    const item = { uuid: 'calendar-note', text: serializeCalendarDocument(initial), locked: options.locked === true }
    const observers: NoteObserver[] = []
    const saves: string[] = []
    let editorFlush: (() => void) | undefined

    const controller = {
      item,
      addNoteInnerValueChangeObserver: (observer: NoteObserver) => {
        observers.push(observer)
        observer(item, 1)
        return () => {
          observers.splice(observers.indexOf(observer), 1)
        }
      },
      registerEditorFlush: (flush: () => void) => {
        editorFlush = flush
        return () => {
          editorFlush = undefined
        }
      },
      flushEditorSerialize: () => editorFlush?.(),
      saveAndAwaitLocalPropagation: (params: { text: string }) => {
        saves.push(params.text)
        return Promise.resolve()
      },
    }

    act(() => {
      root.render(
        <CalendarEditor
          application={{} as WebApplication}
          controller={controller as unknown as NoteViewController}
          readonly={false}
        />,
      )
    })

    return {
      saves,
      /** The note now holds `text`, as far as every observer is told. */
      noteBecomes: (text: string, source: number) => {
        act(() => {
          for (const observer of [...observers]) {
            observer({ ...item, text }, source)
          }
        })
      },
    }
  }

  const chipTitles = (): string[] =>
    Array.from(container.querySelectorAll('button > span > span.truncate')).map((chip) => chip.textContent ?? '')

  const openToday = () => {
    const chip = container.querySelector('button > span > span.truncate')
    const cell = chip?.closest('button')
    expect(cell).not.toBeNull()
    act(() => cell?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  }

  const titleInputs = (): HTMLInputElement[] =>
    Array.from(container.querySelectorAll<HTMLInputElement>('input[placeholder="Event title"]'))

  const type = (input: HTMLInputElement, value: string) => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    act(() => {
      setValue?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  const letTheEditDebounceElapse = () => act(() => jest.advanceTimersByTime(CUSTOM_EDITOR_PERSIST_DEBOUNCE_MS))

  const titlesIn = (text: string): string[] => parseCalendarDocument(text).document.events.map((e) => e.title)

  it('shows the calendar it was opened with', () => {
    mount(calendar([event('a', 'Alpha')]))
    expect(chipTitles()).toEqual(['Alpha'])
  })

  it.each([
    ['other code on this device', LOCAL_CHANGED],
    ['another device', REMOTE_RETRIEVED],
  ])('shows a change made to the note by %s', (_who, source) => {
    const editor = mount(calendar([event('a', 'Alpha')]))

    editor.noteBecomes(serializeCalendarDocument(calendar([event('a', 'Alpha'), event('b', 'Beta')])), source)

    expect(chipTitles()).toEqual(['Alpha', 'Beta'])
    expect(editor.saves).toEqual([])
  })

  it('keeps an edit that is waiting to be saved when the note changes underneath it', () => {
    const editor = mount(calendar([event('a', 'Alpha')]))
    openToday()
    type(titleInputs()[0], 'Alpha, renamed here')

    // Before the edit is saved, something else adds an event to the note.
    editor.noteBecomes(serializeCalendarDocument(calendar([event('a', 'Alpha'), event('b', 'Beta')])), LOCAL_CHANGED)

    expect(chipTitles()).toEqual(['Alpha, renamed here', 'Beta'])
    // The merge is handed to the note at once, in place of the edit that was waiting.
    expect(editor.saves.map(titlesIn)).toEqual([['Alpha, renamed here', 'Beta']])

    letTheEditDebounceElapse()
    expect(editor.saves).toHaveLength(1)
  })

  it('replaces a save that is already queued when the note changes underneath it', () => {
    const editor = mount(calendar([event('a', 'Alpha')]))
    openToday()
    type(titleInputs()[0], 'Alpha, renamed here')
    letTheEditDebounceElapse()
    expect(editor.saves.map(titlesIn)).toEqual([['Alpha, renamed here']])

    // The queued save has not reached the note when another change does.
    editor.noteBecomes(serializeCalendarDocument(calendar([event('a', 'Alpha'), event('b', 'Beta')])), REMOTE_RETRIEVED)

    expect(chipTitles()).toEqual(['Alpha, renamed here', 'Beta'])
    expect(titlesIn(editor.saves[editor.saves.length - 1])).toEqual(['Alpha, renamed here', 'Beta'])
  })

  it('withdraws a queued save of an edit that was undone before the note changed', () => {
    const editor = mount(calendar([event('a', 'Alpha')]))
    openToday()
    type(titleInputs()[0], 'Alpha, renamed here')
    letTheEditDebounceElapse()
    expect(editor.saves.map(titlesIn)).toEqual([['Alpha, renamed here']])
    type(titleInputs()[0], 'Alpha')

    const theirs = serializeCalendarDocument(calendar([event('a', 'Alpha'), event('b', 'Beta')]))
    editor.noteBecomes(theirs, REMOTE_RETRIEVED)

    // The rename is still queued for the note. What replaces it is the note as it now is.
    expect(editor.saves[editor.saves.length - 1]).toBe(theirs)
  })

  it('does not undo a newer edit when its own save comes back', () => {
    const editor = mount(calendar([event('a', 'Alpha')]))
    openToday()
    type(titleInputs()[0], 'First')
    letTheEditDebounceElapse()
    expect(editor.saves).toHaveLength(1)

    type(titleInputs()[0], 'Second')
    editor.noteBecomes(editor.saves[0], LOCAL_CHANGED)

    expect(titleInputs()[0].value).toBe('Second')
    letTheEditDebounceElapse()
    expect(editor.saves.map(titlesIn)).toEqual([['First'], ['Second']])
  })

  it('reads the next change after its own save has come back', () => {
    const editor = mount(calendar([event('a', 'Alpha')]))
    openToday()
    type(titleInputs()[0], 'Mine')
    letTheEditDebounceElapse()
    editor.noteBecomes(editor.saves[0], LOCAL_CHANGED)

    editor.noteBecomes(serializeCalendarDocument(calendar([event('a', 'Changed elsewhere')])), LOCAL_CHANGED)

    expect(chipTitles()).toEqual(['Changed elsewhere'])
    expect(editor.saves).toHaveLength(1)
  })

  it('does not write a note back when nothing in it changed', () => {
    const editor = mount(calendar([event('a', 'Alpha')]))
    openToday()
    type(titleInputs()[0], 'Alpha!')
    type(titleInputs()[0], 'Alpha')

    letTheEditDebounceElapse()

    expect(editor.saves).toEqual([])
  })

  it('keeps what it does not understand about an event when the event is made all-day', () => {
    const timed: CalendarEvent = {
      id: 'a',
      date: today,
      title: 'Alpha',
      color: '#ef4444',
      allDay: false,
      start: new Date(`${today}T09:00`).toISOString(),
      end: new Date(`${today}T10:00`).toISOString(),
      unknownFields: { geo: [38.72, -9.14], attendees: [{ name: 'Sam' }] },
    }
    const editor = mount(calendar([timed]))
    openToday()
    const allDay = container.querySelector<HTMLInputElement>('input[type="checkbox"]')
    expect(allDay?.checked).toBe(false)

    act(() => allDay?.click())
    letTheEditDebounceElapse()

    expect(editor.saves).toHaveLength(1)
    expect(JSON.parse(editor.saves[0])).toStrictEqual({
      version: 1,
      events: [
        { id: 'a', date: today, title: 'Alpha', color: '#ef4444', geo: [38.72, -9.14], attendees: [{ name: 'Sam' }] },
      ],
    })
  })

  it('takes changes into a locked calendar and never writes to it', () => {
    const editor = mount(calendar([event('a', 'Alpha')]), { locked: true })

    editor.noteBecomes(serializeCalendarDocument(calendar([event('a', 'Alpha'), event('b', 'Beta')])), LOCAL_CHANGED)
    openToday()

    expect(chipTitles()).toEqual(['Alpha', 'Beta'])
    expect(titleInputs().every((input) => input.disabled)).toBe(true)
    // Even an input event that reaches a disabled field changes nothing.
    type(titleInputs()[0], 'Typed into a locked calendar')
    expect(chipTitles()).toEqual(['Alpha', 'Beta'])
    letTheEditDebounceElapse()
    expect(editor.saves).toEqual([])
  })
})
