/**
 * @jest-environment jsdom
 *
 * Standard Red Notes — the collapsed toolbar's one decision, on its own.
 *
 * `useToolbarAutoHide` answers one question: should the command panel be
 * showing right now? This file drives it through a deliberately small stand-in
 * for the ribbon — a tab row with two tabs and an ordinary button, a panel with
 * two buttons, a note, and a menu that lives OUTSIDE the bar — so each rule is
 * exercised in milliseconds and by name, instead of being inferred from a
 * mounted 5000-line component. `ToolbarPlugin.autoHide.spec.tsx` is the other
 * half: it mounts the real toolbar and proves the hook is actually wired in.
 *
 * WHAT THIS CANNOT SHOW. jsdom has no layout and no hover, so nothing here says
 * the panel is drawn in the right place, that the note does not jump when it
 * appears, or that a real pointer produces these events. Those were measured in
 * real browsers against a real build. What is here is the logic those
 * measurements rest on, and the timings are driven with fake timers so "it
 * stays" and "it goes" are exact statements rather than sleeps.
 *
 * The menu being outside the bar is the point of the fixture. The ribbon's
 * dropdowns are rendered outside its DOM subtree, so a pointer moving from a
 * button into that button's own menu LEAVES the bar; a test whose menu sat
 * inside the bar could never fail on the bug this hook exists to prevent.
 */
import { act, useRef, useState } from 'react'
import { createRoot, Root } from 'react-dom/client'
import {
  TOOLBAR_AUTO_HIDE_FOCUS_GRACE_MS,
  TOOLBAR_AUTO_HIDE_HIDE_DELAY_MS,
  TOOLBAR_AUTO_HIDE_REVEAL_DELAY_MS,
  TOOLBAR_AUTO_HIDE_STATE_ATTRIBUTE,
  ToolbarAutoHide,
  useToolbarAutoHide,
} from './useToolbarAutoHide'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type HarnessProps = {
  name: string
  active: boolean
  hasOpenDialog?: boolean
  /** False for a toolbar customised down to one tab, which renders no tab strip. */
  tabStrip?: boolean
  onFocusEditor?: () => void
}

const latest: Record<string, ToolbarAutoHide> = {}
/** How many times each harness has rendered — the toolbar's render cost, in miniature. */
const renders: Record<string, number> = {}
/** How many times each tab's own click handler ran. */
const tabClicks: Record<string, number> = {}

/** One ribbon, as far as the hook is concerned. `name` keeps two of them apart. */
const Harness = ({ name, active, hasOpenDialog = false, tabStrip = true, onFocusEditor }: HarnessProps) => {
  renders[name] = (renders[name] ?? 0) + 1
  const toolbarRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [tab, setTab] = useState('home')
  latest[name] = useToolbarAutoHide({
    active,
    toolbarRef,
    panelRef,
    hasOpenDialog,
    getEditorRootElement: () => document.getElementById(`${name}-note`),
    focusEditor: () => {
      onFocusEditor?.()
      document.getElementById(`${name}-note`)?.focus()
    },
  })
  const select = (next: string) => {
    tabClicks[`${name}-${next}`] = (tabClicks[`${name}-${next}`] ?? 0) + 1
    setTab(next)
  }
  return (
    <>
      <div id={`${name}-bar`} ref={toolbarRef}>
        <div id={`${name}-row`}>
          <button id={`${name}-undo`}>undo</button>
          <button id={`${name}-row-anchor`}>a dropdown in the tab row</button>
          {tabStrip ? (
            <div role="tablist">
              <button id={`${name}-tab-home`} role="tab" aria-selected={tab === 'home'} onClick={() => select('home')}>
                <span id={`${name}-tab-home-label`}>Home</span>
              </button>
              <button
                id={`${name}-tab-insert`}
                role="tab"
                aria-selected={tab === 'insert'}
                onClick={() => select('insert')}
              >
                Insert
              </button>
            </div>
          ) : null}
        </div>
        <div id={`${name}-panel`} ref={panelRef} data-shows={tab}>
          <button id={`${name}-first`}>first</button>
          <button id={`${name}-anchor`}>anchor</button>
        </div>
      </div>
      <div id={`${name}-note`} tabIndex={0}>
        note
      </div>
      {/* Stands for a dropdown: opened from the panel, rendered outside the bar. */}
      <div id={`${name}-menu`}>
        <button id={`${name}-menu-item`}>item</button>
      </div>
    </>
  )
}

let container: HTMLElement
let root: Root

const render = async (...harnesses: HarnessProps[]) => {
  await act(async () => {
    root.render(
      <>
        {harnesses.map((props) => (
          <Harness key={props.name} {...props} />
        ))}
      </>,
    )
  })
}

const el = (id: string) => {
  const found = document.getElementById(id)
  if (!found) {
    throw new Error(`fixture element #${id} is not in the document`)
  }
  return found
}
/** The state the hook has written on the panel: 'revealed', 'hidden', or null when it has written nothing. */
const stateOf = (name = 'a') => el(`${name}-panel`).getAttribute(TOOLBAR_AUTO_HIDE_STATE_ATTRIBUTE)
const isOpen = (name = 'a') => stateOf(name) === 'revealed'
const showing = (name = 'a') => el(`${name}-panel`).getAttribute('data-shows')

/** A pointer event. jsdom's own PointerEvent support varies, so the fields read are set by hand. */
const pointer = (type: 'pointerover' | 'pointerenter' | 'pointerleave', pointerType = 'mouse', buttons = 0) => {
  const event = new Event(type, { bubbles: type === 'pointerover' })
  Object.defineProperty(event, 'pointerType', { value: pointerType })
  Object.defineProperty(event, 'buttons', { value: buttons })
  return event
}

const dispatch = async (target: Element | Document, event: Event) => {
  await act(async () => {
    target.dispatchEvent(event)
    await Promise.resolve()
  })
}

const advance = async (ms: number) => {
  await act(async () => {
    jest.advanceTimersByTime(ms)
    await Promise.resolve()
  })
}

/** Lets a MutationObserver deliver, which it does on a microtask. */
const settle = async () => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const focus = async (id: string) => {
  await act(async () => {
    el(id).focus()
    await Promise.resolve()
  })
}

const click = async (id: string) => {
  await act(async () => {
    el(id).click()
    await Promise.resolve()
  })
}

/** The pointer comes onto the bar, landing on `id`. */
const enterBarAt = async (id: string, name = 'a') => {
  await dispatch(el(`${name}-bar`), pointer('pointerenter'))
  await dispatch(el(id), pointer('pointerover'))
}
/** The pointer, already on the bar, moves onto `id`. */
const moveTo = (id: string) => dispatch(el(id), pointer('pointerover'))
const leaveBar = (name = 'a') => dispatch(el(`${name}-bar`), pointer('pointerleave'))

/** Rest the pointer on a tab for as long as it takes to count. */
const restOnTab = async (tab = 'home', name = 'a') => {
  await enterBarAt(`${name}-tab-${tab}`, name)
  await advance(TOOLBAR_AUTO_HIDE_REVEAL_DELAY_MS)
}

const LONG = TOOLBAR_AUTO_HIDE_HIDE_DELAY_MS * 5

beforeEach(() => {
  // Microtasks are left real: MutationObserver and React both deliver on them.
  jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] })
  for (const key of Object.keys(tabClicks)) {
    delete tabClicks[key]
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  jest.useRealTimers()
})

describe('when the toolbar is not collapsed', () => {
  /** The panel's attributes, which must be only the ones the harness itself rendered. */
  const panelAttributes = () =>
    Array.from(el('a-panel').attributes)
      .map((attribute) => attribute.name)
      .sort()

  it('writes nothing on the panel', async () => {
    await render({ name: 'a', active: false })
    expect(panelAttributes()).toEqual(['data-shows', 'id'])
  })

  it('reacts to nothing: pointer, focus, a click on a tab, an open menu and a dialog all leave it alone', async () => {
    await render({ name: 'a', active: false, hasOpenDialog: true })
    await restOnTab('insert')
    await click('a-tab-home')
    await focus('a-first')
    el('a-anchor').setAttribute('aria-expanded', 'true')
    await settle()
    await advance(LONG)
    expect(panelAttributes()).toEqual(['data-shows', 'id'])
    // Pointing at a tab did not switch to it either: that is a collapsed-only behaviour.
    expect(tabClicks['a-insert']).toBeUndefined()
  })

  it('attaches no listener to the bar or the document', async () => {
    const elementAdd = jest.spyOn(HTMLElement.prototype, 'addEventListener')
    const documentAdd = jest.spyOn(document, 'addEventListener')
    await render({ name: 'a', active: false })
    const ours = ['pointerover', 'pointerenter', 'pointerleave', 'focusin', 'focusout', 'pointerdown']
    expect(elementAdd.mock.calls.filter(([type]) => ours.includes(type))).toEqual([])
    expect(documentAdd.mock.calls.filter(([type]) => ours.includes(type))).toEqual([])
  })

  it('makes its callbacks harmless', async () => {
    await render({ name: 'a', active: false })
    await act(async () => {
      latest.a.revealAndFocus()
      latest.a.release()
    })
    await advance(LONG)
    expect(latest.a.containsFocus()).toBe(false)
    expect(panelAttributes()).toEqual(['data-shows', 'id'])
  })
})

describe('collapsed, at rest', () => {
  it('starts with the panel put away, and it stays away', async () => {
    await render({ name: 'a', active: true })
    expect(stateOf()).toBe('hidden')
    await advance(LONG)
    expect(stateOf()).toBe('hidden')
  })

  it('makes the hidden panel inert, so its invisible controls are not in the tab order', async () => {
    await render({ name: 'a', active: true })
    expect(el('a-panel').hasAttribute('inert')).toBe(true)
    await restOnTab()
    expect(el('a-panel').hasAttribute('inert')).toBe(false)
    await leaveBar()
    await advance(TOOLBAR_AUTO_HIDE_HIDE_DELAY_MS)
    expect(el('a-panel').hasAttribute('inert')).toBe(true)
  })

  it('leaves the tab row alone: it is never marked or made inert', async () => {
    await render({ name: 'a', active: true })
    expect(el('a-row').hasAttribute('inert')).toBe(false)
    expect(el('a-bar').hasAttribute('inert')).toBe(false)
    expect(el('a-bar').hasAttribute(TOOLBAR_AUTO_HIDE_STATE_ATTRIBUTE)).toBe(false)
  })
})

describe('the cost of pointing at the toolbar', () => {
  it('opens and closes the panel without re-rendering the component that hosts it', async () => {
    // The host in the app is a 5000-line component. Built on React state, this
    // hook re-rendered it on every change and took most of a second to open
    // the panel in a development build. The whole cycle must cost no render.
    // (Switching to ANOTHER tab does render: that changes what the panel holds.)
    await render({ name: 'a', active: true })
    const before = renders.a

    await restOnTab('home')
    expect(isOpen()).toBe(true)
    await moveTo('a-first')
    el('a-anchor').setAttribute('aria-expanded', 'true')
    await settle()
    await leaveBar()
    el('a-anchor').removeAttribute('aria-expanded')
    await settle()
    await focus('a-first')
    await focus('a-note')
    await advance(LONG)
    expect(stateOf()).toBe('hidden')

    expect(renders.a).toBe(before)
  })
})

describe('pointing at a tab', () => {
  it('opens the panel once the pointer has rested there, not before', async () => {
    await render({ name: 'a', active: true })
    await enterBarAt('a-tab-home')
    await advance(TOOLBAR_AUTO_HIDE_REVEAL_DELAY_MS - 1)
    expect(isOpen()).toBe(false)
    await advance(1)
    expect(isOpen()).toBe(true)
  })

  it('counts the inside of a tab as the tab', async () => {
    // The pointer lands on a tab's label, not on the button element itself.
    await render({ name: 'a', active: true })
    await enterBarAt('a-tab-home-label')
    await advance(TOOLBAR_AUTO_HIDE_REVEAL_DELAY_MS)
    expect(isOpen()).toBe(true)
  })

  it('does not open for a pointer that only sweeps across the tabs', async () => {
    await render({ name: 'a', active: true })
    await enterBarAt('a-tab-home')
    await advance(TOOLBAR_AUTO_HIDE_REVEAL_DELAY_MS - 1)
    await moveTo('a-tab-insert')
    await advance(TOOLBAR_AUTO_HIDE_REVEAL_DELAY_MS - 1)
    await leaveBar()
    await advance(LONG)
    expect(isOpen()).toBe(false)
    // ...and it switched to neither tab on the way past.
    expect(tabClicks).toEqual({})
  })

  it('shows the commands of the tab being pointed at', async () => {
    await render({ name: 'a', active: true })
    expect(showing()).toBe('home')
    await restOnTab('insert')
    expect(isOpen()).toBe(true)
    expect(showing()).toBe('insert')
  })

  it('switches to another tab when the pointer moves to it while the panel is open', async () => {
    await render({ name: 'a', active: true })
    await restOnTab('home')
    await moveTo('a-tab-insert')
    await advance(TOOLBAR_AUTO_HIDE_REVEAL_DELAY_MS - 1)
    expect(showing()).toBe('home')
    await advance(1)
    expect(showing()).toBe('insert')
    expect(isOpen()).toBe(true)
  })

  it('does not re-select the tab that is already showing', async () => {
    await render({ name: 'a', active: true })
    await restOnTab('home')
    expect(isOpen()).toBe(true)
    expect(tabClicks['a-home']).toBeUndefined()
  })

  it('does not open for a pointer on some other control in the tab row', async () => {
    // The row also holds Undo, Print and the like. Reaching for those is not
    // reaching for the commands.
    await render({ name: 'a', active: true })
    await enterBarAt('a-undo')
    await advance(LONG)
    expect(isOpen()).toBe(false)
  })

  it('keeps the panel while the pointer moves down into it, without a blink', async () => {
    await render({ name: 'a', active: true })
    await restOnTab()
    const states: boolean[] = []
    // Off the tab and onto a command: the reason it opened is gone, and the
    // reason it stays is "the pointer is still on the bar".
    await moveTo('a-first')
    states.push(isOpen())
    await advance(LONG)
    states.push(isOpen())
    expect(states).toEqual([true, true])
  })

  it('keeps the open panel while the pointer is on any part of the bar', async () => {
    await render({ name: 'a', active: true })
    await restOnTab()
    await moveTo('a-undo')
    await advance(LONG)
    expect(isOpen()).toBe(true)
  })

  it('closes the panel a short delay after the pointer leaves the bar, not at once', async () => {
    await render({ name: 'a', active: true })
    await restOnTab()
    await leaveBar()
    await advance(TOOLBAR_AUTO_HIDE_HIDE_DELAY_MS - 1)
    expect(isOpen()).toBe(true)
    await advance(1)
    expect(isOpen()).toBe(false)
  })

  it('does not close if the pointer comes back within that delay', async () => {
    await render({ name: 'a', active: true })
    await restOnTab()
    await leaveBar()
    await advance(TOOLBAR_AUTO_HIDE_HIDE_DELAY_MS - 1)
    await enterBarAt('a-first')
    await advance(LONG)
    expect(isOpen()).toBe(true)
  })

  it('ignores a touch arriving on a tab, which is not a hover', async () => {
    await render({ name: 'a', active: true })
    await dispatch(el('a-bar'), pointer('pointerenter', 'touch'))
    await dispatch(el('a-tab-home'), pointer('pointerover', 'touch'))
    await advance(LONG)
    expect(isOpen()).toBe(false)
  })

  it('ignores a pointer that arrives with a button held down, which is a drag passing over', async () => {
    // Extending a text selection up to the top of the note drags the pointer
    // across the tab row. Dropping the panel onto the lines being selected
    // would be the feature getting in the way of the thing it is for.
    await render({ name: 'a', active: true })
    await dispatch(el('a-bar'), pointer('pointerenter', 'mouse', 1))
    await dispatch(el('a-tab-home'), pointer('pointerover', 'mouse', 1))
    await advance(LONG)
    expect(isOpen()).toBe(false)
  })

  it('falls back to the row itself when the toolbar has no tab strip', async () => {
    await render({ name: 'a', active: true, tabStrip: false })
    await enterBarAt('a-undo')
    await advance(TOOLBAR_AUTO_HIDE_REVEAL_DELAY_MS)
    expect(isOpen()).toBe(true)
  })
})

describe('activating a tab (click, tap or keyboard)', () => {
  const press = (id: string) => dispatch(el(id), new Event('pointerdown', { bubbles: true }))

  it('opens the panel and keeps it with no pointer and no focus on it', async () => {
    await render({ name: 'a', active: true })
    await click('a-tab-insert')
    expect(isOpen()).toBe(true)
    expect(showing()).toBe('insert')
    await advance(LONG)
    expect(isOpen()).toBe(true)
  })

  it('lets go when the open tab is activated again', async () => {
    await render({ name: 'a', active: true })
    await click('a-tab-home')
    await click('a-tab-home')
    await advance(TOOLBAR_AUTO_HIDE_HIDE_DELAY_MS)
    expect(isOpen()).toBe(false)
  })

  it('keeps holding, and switches, when a different tab is activated', async () => {
    await render({ name: 'a', active: true })
    await click('a-tab-home')
    await click('a-tab-insert')
    await advance(LONG)
    expect(isOpen()).toBe(true)
    expect(showing()).toBe('insert')
  })

  it('is not what switching tabs on hover does: a panel opened by pointing still closes on leaving', async () => {
    // Hover switches tabs through the tab's own click handler. That must not be
    // mistaken for the user clicking, or every hover would pin the panel open.
    await render({ name: 'a', active: true })
    await restOnTab('insert')
    expect(tabClicks['a-insert']).toBe(1)
    await leaveBar()
    await advance(TOOLBAR_AUTO_HIDE_HIDE_DELAY_MS)
    expect(isOpen()).toBe(false)
  })

  it('lets go when the user presses back in the note', async () => {
    await render({ name: 'a', active: true })
    await click('a-tab-home')
    await press('a-note')
    await advance(TOOLBAR_AUTO_HIDE_HIDE_DELAY_MS)
    expect(isOpen()).toBe(false)
  })

  it('does not let go for a press on the bar itself', async () => {
    await render({ name: 'a', active: true })
    await click('a-tab-home')
    await press('a-first')
    await press('a-undo')
    await advance(LONG)
    expect(isOpen()).toBe(true)
  })

  it('does not let go for a press made while a menu of its own is open', async () => {
    // Choosing a menu item is a press outside the bar. It is aimed at the menu,
    // so the panel must still be there for the next thing the user wants from it.
    await render({ name: 'a', active: true })
    await click('a-tab-home')
    el('a-anchor').setAttribute('aria-expanded', 'true')
    await settle()
    await press('a-menu-item')
    el('a-anchor').removeAttribute('aria-expanded')
    await settle()
    await advance(LONG)
    expect(isOpen()).toBe(true)
  })

  it('lets go when the user types in the note', async () => {
    await render({ name: 'a', active: true })
    await click('a-tab-home')
    await dispatch(el('a-note'), new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    await advance(TOOLBAR_AUTO_HIDE_HIDE_DELAY_MS)
    expect(isOpen()).toBe(false)
  })

  it('does not let go for a bare modifier key, or for a key pressed somewhere else', async () => {
    await render({ name: 'a', active: true })
    await click('a-tab-home')
    await dispatch(el('a-note'), new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }))
    await dispatch(el('a-menu-item'), new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    await advance(LONG)
    expect(isOpen()).toBe(true)
  })

  it('can be released by the toolbar', async () => {
    await render({ name: 'a', active: true })
    await click('a-tab-home')
    await act(async () => latest.a.release())
    await advance(TOOLBAR_AUTO_HIDE_HIDE_DELAY_MS)
    expect(isOpen()).toBe(false)
  })

  it('ignores a click on a control in the row that is not a tab', async () => {
    await render({ name: 'a', active: true })
    await click('a-undo')
    await advance(LONG)
    expect(isOpen()).toBe(false)
  })
})

describe('keyboard focus', () => {
  it('keeps the panel while focus is inside it', async () => {
    await render({ name: 'a', active: true })
    await click('a-tab-home')
    await focus('a-first')
    await click('a-tab-home')
    await advance(LONG)
    // The hold was let go by the second click; focus alone is keeping it now.
    expect(document.activeElement).toBe(el('a-first'))
    expect(isOpen()).toBe(true)
  })

  it('closes the panel once focus has gone back to the note', async () => {
    await render({ name: 'a', active: true })
    await restOnTab()
    await focus('a-first')
    await leaveBar()
    await focus('a-note')
    await advance(TOOLBAR_AUTO_HIDE_HIDE_DELAY_MS)
    expect(isOpen()).toBe(false)
  })

  it('does not open just because focus is on a tab', async () => {
    // Tabbing through the row passes over every tab. Opening on each would be
    // the keyboard version of flashing the panel at a sweeping pointer.
    await render({ name: 'a', active: true })
    await focus('a-tab-home')
    await advance(LONG)
    expect(isOpen()).toBe(false)
  })

  it('keeps the panel, and the place in it, when the whole window loses focus', async () => {
    // Alt-tabbing away blurs the focused button with no element taking focus.
    // Hiding then would make the panel inert under that focus and the browser
    // would drop it.
    await render({ name: 'a', active: true })
    await restOnTab()
    await focus('a-first')
    await leaveBar()
    jest.spyOn(document, 'hasFocus').mockReturnValue(false)
    await dispatch(el('a-first'), new FocusEvent('focusout', { bubbles: true, relatedTarget: null }))
    await advance(LONG)
    expect(isOpen()).toBe(true)
    expect(el('a-panel').hasAttribute('inert')).toBe(false)
  })

  it('does close when focus leaves for nothing in particular while the window still has focus', async () => {
    // The control for the test above: the same event, the window still focused.
    // That is a click on empty space, and it IS leaving the toolbar.
    await render({ name: 'a', active: true })
    await restOnTab()
    await focus('a-first')
    await leaveBar()
    jest.spyOn(document, 'hasFocus').mockReturnValue(true)
    await dispatch(el('a-first'), new FocusEvent('focusout', { bubbles: true, relatedTarget: null }))
    await advance(TOOLBAR_AUTO_HIDE_HIDE_DELAY_MS)
    expect(isOpen()).toBe(false)
  })

  it('reports whether focus is inside the panel', async () => {
    await render({ name: 'a', active: true })
    await click('a-tab-home')
    await focus('a-note')
    expect(latest.a.containsFocus()).toBe(false)
    // The tab row is not the panel.
    await focus('a-tab-home')
    expect(latest.a.containsFocus()).toBe(false)
    await focus('a-first')
    expect(latest.a.containsFocus()).toBe(true)
    // Nor is a menu: focus in it is the open-surface rule's business.
    await focus('a-menu-item')
    expect(latest.a.containsFocus()).toBe(false)
  })

  it('hands focus back to the note on Escape from inside the panel', async () => {
    const onFocusEditor = jest.fn()
    await render({ name: 'a', active: true, onFocusEditor })
    await click('a-tab-home')
    await focus('a-first')
    await dispatch(el('a-first'), new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(onFocusEditor).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(el('a-note'))
    await advance(TOOLBAR_AUTO_HIDE_HIDE_DELAY_MS)
    expect(isOpen()).toBe(false)
  })

  it('closes on Escape from a tab without taking focus off the tab', async () => {
    const onFocusEditor = jest.fn()
    await render({ name: 'a', active: true, onFocusEditor })
    await focus('a-tab-home')
    await click('a-tab-home')
    expect(isOpen()).toBe(true)
    await dispatch(el('a-tab-home'), new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await advance(TOOLBAR_AUTO_HIDE_HIDE_DELAY_MS)
    expect(isOpen()).toBe(false)
    expect(onFocusEditor).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(el('a-tab-home'))
  })

  it('leaves an Escape alone when a control inside the panel has already used it', async () => {
    const onFocusEditor = jest.fn()
    await render({ name: 'a', active: true, onFocusEditor })
    await click('a-tab-home')
    await focus('a-first')
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    escape.preventDefault()
    await dispatch(el('a-first'), escape)
    expect(onFocusEditor).not.toHaveBeenCalled()
    await advance(LONG)
    expect(isOpen()).toBe(true)
  })
})

describe('something the panel opened is still open', () => {
  /** Open a menu from the panel, then move the pointer off the bar and into the menu. */
  const openMenuAndMoveIntoIt = async () => {
    await restOnTab()
    await moveTo('a-anchor')
    el('a-anchor').setAttribute('aria-expanded', 'true')
    await settle()
    // The menu is not inside the bar, so this is a real exit from it.
    expect(el('a-bar').contains(el('a-menu-item'))).toBe(false)
    await leaveBar()
  }

  it('keeps the panel while a menu anchored to it is open, even though the pointer has left the bar', async () => {
    await render({ name: 'a', active: true })
    await openMenuAndMoveIntoIt()
    await advance(LONG)
    expect(isOpen()).toBe(true)
  })

  it('would have closed without the open menu — the same moves, minus the anchor', async () => {
    // The control for the test above. If this did not close, the test above would
    // be passing because nothing ever closes, not because the menu holds the panel.
    await render({ name: 'a', active: true })
    await restOnTab()
    await moveTo('a-anchor')
    await leaveBar()
    await advance(LONG)
    expect(isOpen()).toBe(false)
  })

  it('closes the panel a short delay after the menu closes', async () => {
    await render({ name: 'a', active: true })
    await openMenuAndMoveIntoIt()
    await advance(LONG)
    el('a-anchor').removeAttribute('aria-expanded')
    await settle()
    await advance(TOOLBAR_AUTO_HIDE_HIDE_DELAY_MS - 1)
    expect(isOpen()).toBe(true)
    await advance(1)
    expect(isOpen()).toBe(false)
  })

  it('does not count a collapsed anchor', async () => {
    await render({ name: 'a', active: true })
    await restOnTab()
    el('a-anchor').setAttribute('aria-expanded', 'false')
    await settle()
    await leaveBar()
    await advance(LONG)
    expect(isOpen()).toBe(false)
  })

  it('lets go when the expanded anchor is removed from the panel outright', async () => {
    // Switching tabs unmounts a button without ever clearing its attribute.
    await render({ name: 'a', active: true })
    await openMenuAndMoveIntoIt()
    await advance(LONG)
    expect(isOpen()).toBe(true)
    el('a-anchor').remove()
    await settle()
    await advance(TOOLBAR_AUTO_HIDE_HIDE_DELAY_MS)
    expect(isOpen()).toBe(false)
  })

  it('does not open a closed panel for a dropdown that belongs to the tab row', async () => {
    // Undo history, paste options and the like hang off the row, which is always
    // there. They need nothing from the panel, so they must not drag it open.
    await render({ name: 'a', active: true })
    el('a-row-anchor').setAttribute('aria-expanded', 'true')
    await settle()
    await advance(LONG)
    expect(isOpen()).toBe(false)
  })

  it('starts open when a menu anchored to the panel is already open at the moment of collapsing', async () => {
    await render({ name: 'a', active: false })
    el('a-anchor').setAttribute('aria-expanded', 'true')
    await render({ name: 'a', active: true })
    await settle()
    await advance(LONG)
    expect(isOpen()).toBe(true)
  })

  it('keeps an open panel while a dialog it launched is open, and lets go when the dialog closes', async () => {
    await render({ name: 'a', active: true })
    await restOnTab()
    await render({ name: 'a', active: true, hasOpenDialog: true })
    await leaveBar()
    await advance(LONG)
    expect(isOpen()).toBe(true)
    await render({ name: 'a', active: true, hasOpenDialog: false })
    await advance(TOOLBAR_AUTO_HIDE_HIDE_DELAY_MS)
    expect(isOpen()).toBe(false)
  })

  it('does not open a closed panel just because a dialog is open', async () => {
    await render({ name: 'a', active: true, hasOpenDialog: true })
    await advance(LONG)
    expect(isOpen()).toBe(false)
  })
})

describe('asking for the panel from the keyboard shortcut', () => {
  it('opens it at once and moves focus to its first control', async () => {
    await render({ name: 'a', active: true })
    await focus('a-note')
    await act(async () => latest.a.revealAndFocus())
    expect(isOpen()).toBe(true)
    expect(document.activeElement).toBe(el('a-first'))
    await advance(LONG)
    expect(isOpen()).toBe(true)
  })

  it('moves focus only after the panel has been opened', async () => {
    // The panel is inert while hidden, so a focus attempt made before it was
    // opened would land nowhere.
    let whenFocused: { open: boolean; inert: boolean } | undefined
    await render({ name: 'a', active: true })
    el('a-first').addEventListener('focus', () => {
      whenFocused = { open: isOpen(), inert: el('a-panel').hasAttribute('inert') }
    })
    await act(async () => latest.a.revealAndFocus())
    expect(whenFocused).toEqual({ open: true, inert: false })
  })

  it('waits for focus that is slow to arrive, longer than the ordinary hide delay', async () => {
    await render({ name: 'a', active: true })
    const first = el('a-first')
    const anchor = el('a-anchor')
    first.remove()
    anchor.remove()
    await act(async () => latest.a.revealAndFocus())
    await advance(TOOLBAR_AUTO_HIDE_HIDE_DELAY_MS * 2)
    expect(isOpen()).toBe(true)

    el('a-panel').appendChild(first)
    await focus('a-first')
    await advance(LONG)
    expect(isOpen()).toBe(true)
  })

  it('gives up and closes again if focus never arrives', async () => {
    await render({ name: 'a', active: true })
    el('a-first').remove()
    el('a-anchor').remove()
    await act(async () => latest.a.revealAndFocus())
    await advance(TOOLBAR_AUTO_HIDE_FOCUS_GRACE_MS - 1)
    expect(isOpen()).toBe(true)
    await advance(1 + TOOLBAR_AUTO_HIDE_HIDE_DELAY_MS)
    expect(isOpen()).toBe(false)
  })
})

describe('expanding the toolbar and collapsing it again', () => {
  it('takes its attributes back off the panel when expanded, and starts put away when collapsed again', async () => {
    await render({ name: 'a', active: true })
    await click('a-tab-home')
    expect(isOpen()).toBe(true)

    await render({ name: 'a', active: false })
    // Nothing of the collapsed state is left on the element: it is the panel it was.
    expect(stateOf()).toBeNull()
    expect(el('a-panel').hasAttribute('inert')).toBe(false)

    await render({ name: 'a', active: true })
    await advance(LONG)
    // The earlier request to keep it open did not survive the round trip.
    expect(stateOf()).toBe('hidden')
  })

  it('does not leave a pending close behind to fire on a panel it no longer manages', async () => {
    await render({ name: 'a', active: true })
    await restOnTab()
    await leaveBar()
    // A close is now due in TOOLBAR_AUTO_HIDE_HIDE_DELAY_MS.
    await render({ name: 'a', active: false })
    await advance(LONG)
    expect(stateOf()).toBeNull()
    expect(el('a-panel').hasAttribute('inert')).toBe(false)
  })

  it('stops listening to the document once it is no longer collapsed', async () => {
    const remove = jest.spyOn(document, 'removeEventListener')
    await render({ name: 'a', active: true })
    await render({ name: 'a', active: false })
    expect(remove.mock.calls.map(([type]) => type)).toEqual(expect.arrayContaining(['pointerdown', 'keydown']))
  })
})

describe('two toolbars mounted at once', () => {
  it('each keeps its own state', async () => {
    await render({ name: 'a', active: true }, { name: 'b', active: true })
    await restOnTab('home', 'a')
    expect(isOpen('a')).toBe(true)
    expect(isOpen('b')).toBe(false)

    await click('b-tab-home')
    await leaveBar('a')
    await advance(TOOLBAR_AUTO_HIDE_HIDE_DELAY_MS)
    expect(isOpen('a')).toBe(false)
    expect(isOpen('b')).toBe(true)
  })

  it('an open menu on one does not hold the other', async () => {
    await render({ name: 'a', active: true }, { name: 'b', active: true })
    await restOnTab('home', 'a')
    await restOnTab('home', 'b')
    el('a-anchor').setAttribute('aria-expanded', 'true')
    await settle()
    await leaveBar('a')
    await leaveBar('b')
    await advance(LONG)
    expect(isOpen('a')).toBe(true)
    expect(isOpen('b')).toBe(false)
  })

  it('a press inside one toolbar counts as going elsewhere for the other', async () => {
    await render({ name: 'a', active: true }, { name: 'b', active: true })
    await click('a-tab-home')
    await click('b-tab-home')
    await dispatch(el('b-first'), new Event('pointerdown', { bubbles: true }))
    await advance(TOOLBAR_AUTO_HIDE_HIDE_DELAY_MS)
    expect(isOpen('a')).toBe(false)
    expect(isOpen('b')).toBe(true)
  })
})
