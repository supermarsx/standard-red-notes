/**
 * @jest-environment jsdom
 *
 * Standard Red Notes: the "Allow note covers" Preferences card (t111 §3 row 4).
 *
 * Two things are under test and the second is the interesting one:
 *
 *  1. The control itself — default OFF, written through the SAME seam the note's
 *     own banner gate reads (`noteCoversPreference.ts`), so Preferences and the
 *     note cannot disagree about whether covers are on.
 *  2. THE HONEST-ABSENCE RULE. The copy reports how many notes currently hold a
 *     hidden cover. When the local database has not been read, the count is NOT
 *     zero — it is unknown — and the sentence must not render at all. An empty
 *     array would be counted honestly as zero and the surface would then assert
 *     "nothing is hidden" when the truth is "we have not looked".
 *
 * No @testing-library in this repo: react-dom/client createRoot + act.
 */
import { ApplicationEvent, SNNote } from '@standardnotes/snjs'
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { NOTE_COVERS_ENABLED_PREF_KEY } from '@/HeroHeader/noteCoversPreference'

const COVER_DATA_URL = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ'

const noteWithCover = () =>
  ({ getAppDomainValue: () => ({ imageDataUrl: COVER_DATA_URL, height: 200 }) }) as unknown as SNNote
const noteWithoutCover = () => ({ getAppDomainValue: () => undefined }) as unknown as SNNote

type Harness = {
  application: import('@/Application/WebApplication').WebApplication
  prefs: Map<string, unknown>
  setPreference: jest.Mock
  emitPreferencesChanged: () => Promise<void>
  emitLocalDataLoaded: () => Promise<void>
  setDatabaseLoaded: (loaded: boolean) => void
  setNotes: (notes: SNNote[]) => void
}

let harness: Harness

const buildHarness = (options: { databaseLoaded?: boolean; notes?: SNNote[]; prefs?: [string, unknown][] } = {}) => {
  const prefs = new Map<string, unknown>(options.prefs ?? [])
  let databaseLoaded = options.databaseLoaded ?? true
  let notes = options.notes ?? []
  const observers = new Map<ApplicationEvent, (() => Promise<void>)[]>()

  const setPreference = jest.fn(async (key: string, value: unknown) => {
    prefs.set(key, value)
    for (const observer of observers.get(ApplicationEvent.PreferencesChanged) ?? []) {
      await observer()
    }
  })

  const application = {
    getPreference: (key: string, defaultValue?: unknown) => (prefs.has(key) ? prefs.get(key) : defaultValue),
    setPreference,
    addEventObserver: (callback: () => Promise<void>, event: ApplicationEvent) => {
      const list = observers.get(event) ?? []
      list.push(callback)
      observers.set(event, list)
      return () => {
        observers.set(
          event,
          (observers.get(event) ?? []).filter((entry) => entry !== callback),
        )
      }
    },
    sync: { isDatabaseLoaded: () => databaseLoaded },
    items: {
      getDisplayableNotes: () => notes,
      streamItems: () => () => undefined,
    },
    preferences: {
      getLocalValue: (_key: unknown, defaultValue?: unknown) => defaultValue,
      setLocalValue: jest.fn(),
    },
  } as unknown as import('@/Application/WebApplication').WebApplication

  harness = {
    application,
    prefs,
    setPreference,
    emitPreferencesChanged: async () => {
      for (const observer of observers.get(ApplicationEvent.PreferencesChanged) ?? []) {
        await observer()
      }
    },
    emitLocalDataLoaded: async () => {
      for (const observer of observers.get(ApplicationEvent.LocalDataLoaded) ?? []) {
        await observer()
      }
    },
    setDatabaseLoaded: (loaded: boolean) => {
      databaseLoaded = loaded
    },
    setNotes: (next: SNNote[]) => {
      notes = next
    },
  }
  return harness
}

jest.mock('@/Components/ApplicationProvider', () => ({
  useApplication: () => harness.application,
}))

import NoteCovers from './NoteCovers'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const render = async () => {
  await act(async () => {
    root.render(createElement(NoteCovers, { application: harness.application }))
  })
  await act(async () => {})
}

const switchInput = () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')
const hiddenCountNode = () => container.querySelector('[data-test="note-covers-hidden-count"]')

const toggle = async () => {
  const input = switchInput()
  expect(input).not.toBeNull()
  await act(async () => {
    input?.click()
  })
  await act(async () => {})
}

describe('the covers switch', () => {
  it('renders OFF when nothing is stored — the shipped default, not a falsy PrefDefaults lookup', async () => {
    buildHarness()
    await render()

    expect(switchInput()).not.toBeNull()
    expect(switchInput()?.checked).toBe(false)
  })

  it('renders ON only for a literal stored `true`', async () => {
    buildHarness({ prefs: [[String(NOTE_COVERS_ENABLED_PREF_KEY), true]] })
    await render()
    expect(switchInput()?.checked).toBe(true)
  })

  it('treats a non-boolean synced value as OFF rather than coercing it', async () => {
    // A differently-versioned client could have written anything here. Off is the
    // safe direction: it only ever hides a decoration.
    buildHarness({ prefs: [[String(NOTE_COVERS_ENABLED_PREF_KEY), 'yes']] })
    await render()
    expect(switchInput()?.checked).toBe(false)
  })

  it('writes to the SAME pinned key the note banner gate reads, and reflects it back', async () => {
    buildHarness()
    await render()
    await toggle()

    expect(harness.setPreference).toHaveBeenCalledTimes(1)
    expect(harness.setPreference).toHaveBeenCalledWith(NOTE_COVERS_ENABLED_PREF_KEY, true)
    // The literal is what actually lands in storage; this is the mirror property.
    expect(harness.prefs.get('noteCoversEnabled')).toBe(true)
    expect(switchInput()?.checked).toBe(true)
  })

  it('says that the setting hides existing covers and that nothing is deleted', async () => {
    buildHarness()
    await render()

    const text = container.textContent ?? ''
    expect(text).toContain('shown')
    expect(text).toContain('stops displaying it')
    expect(text).toContain('Nothing is deleted')
    expect(text).toContain('comes back exactly as it was')
  })
})

describe('the hidden-cover count', () => {
  it('renders NO sentence while the items are unloaded — unknown is not zero', async () => {
    // THE RULE. `getDisplayableNotes()` would answer `[]` here, which counted
    // honestly is zero; passing that on would make the copy assert that nothing is
    // hidden when nothing has been looked at.
    buildHarness({ databaseLoaded: false, notes: [noteWithCover(), noteWithCover()] })
    await render()

    expect(hiddenCountNode()).toBeNull()
    expect(container.textContent ?? '').not.toContain('hidden cover')
  })

  it('renders NO sentence when the count is a real zero either', async () => {
    buildHarness({ databaseLoaded: true, notes: [noteWithoutCover()] })
    await render()

    expect(hiddenCountNode()).toBeNull()
  })

  it('reports the count, singular, when covers are off and one note has one', async () => {
    buildHarness({ databaseLoaded: true, notes: [noteWithCover(), noteWithoutCover()] })
    await render()

    expect(hiddenCountNode()?.textContent).toBe('1 note has a hidden cover.')
  })

  it('reports the count, plural, for several', async () => {
    buildHarness({ databaseLoaded: true, notes: [noteWithCover(), noteWithCover(), noteWithoutCover()] })
    await render()

    expect(hiddenCountNode()?.textContent).toBe('2 notes have a hidden cover.')
  })

  it('says nothing once covers are ON, because then nothing is hidden', async () => {
    buildHarness({
      databaseLoaded: true,
      notes: [noteWithCover(), noteWithCover()],
      prefs: [[String(NOTE_COVERS_ENABLED_PREF_KEY), true]],
    })
    await render()

    expect(hiddenCountNode()).toBeNull()
  })

  it('stops claiming nothing is hidden the moment the database finishes loading', async () => {
    buildHarness({ databaseLoaded: false, notes: [] })
    await render()
    expect(hiddenCountNode()).toBeNull()

    harness.setDatabaseLoaded(true)
    harness.setNotes([noteWithCover()])
    await act(async () => {
      await harness.emitLocalDataLoaded()
    })

    expect(hiddenCountNode()?.textContent).toBe('1 note has a hidden cover.')
  })

  it('drops the sentence when the switch is turned on, without a reload', async () => {
    buildHarness({ databaseLoaded: true, notes: [noteWithCover()] })
    await render()
    expect(hiddenCountNode()).not.toBeNull()

    await toggle()

    expect(switchInput()?.checked).toBe(true)
    expect(hiddenCountNode()).toBeNull()
  })
})
