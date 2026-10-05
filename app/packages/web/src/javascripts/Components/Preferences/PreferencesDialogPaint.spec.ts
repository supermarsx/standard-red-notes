import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8')

/**
 * The Preferences dialog must not end up with a backdrop filter.
 *
 * `ModalOverlay` gives every dialog `backdrop-filter: var(--popover-backdrop-filter)`,
 * which with translucent UI on — the default — is a twelve pixel blur plus saturate,
 * contrast and brightness. The Preferences dialog overrides the shared modal box to
 * be the FULL VIEWPORT and fills it with opaque children, so that filter resamples
 * about 1.4 megapixels of a backdrop nobody can ever see, on every frame of every
 * scroll. Measured in real headless Chrome on the real shell with the lightest pane
 * it can host: 13.6 fps and a 100ms median frame with the filter, 60.0 fps and a
 * 16.7ms median frame without it, scripting/style/layout ~0ms in both, and a
 * two-pixel difference between screenshots.
 *
 * This is asserted against the SOURCE rather than a rendered computed style on
 * purpose: jsdom has no layout engine and does not apply the Tailwind stylesheet at
 * all, so `getComputedStyle(dialog).backdropFilter` there is the empty string
 * whether the class is present or absent — an assertion on it could never fail. The
 * frame-rate claim above likewise cannot come from jsdom and does not; it comes from
 * a headless-Chrome harness.
 *
 * The invariant is written as a disjunction so it survives both futures: either
 * `ModalOverlay` stops applying the filter to every dialog, or the Preferences
 * wrapper keeps cancelling it. What must never happen is the filter applying and
 * nothing cancelling it.
 */
describe('Preferences dialog paint contract', () => {
  const wrapper = read('./PreferencesViewWrapper.tsx')
  const overlay = read('../Modal/ModalOverlay.tsx')

  /** The shared modal box's own filter declaration, as an arbitrary-property utility. */
  const OVERLAY_APPLIES_FILTER = 'backdrop-filter:var(--popover-backdrop-filter)'

  it('leaves no backdrop filter on the full-viewport Preferences dialog', () => {
    const overlayApplies = overlay.includes(OVERLAY_APPLIES_FILTER)
    // Tailwind v4 emits its utilities inside a cascade layer, and for IMPORTANT
    // declarations layer order is inverted, so the cancellation has to be important
    // too: a plain `backdrop-filter-none` sits at equal specificity and would be
    // decided by source order in the generated sheet, which this file cannot see.
    const wrapperCancels = /md:!backdrop-filter-none/.test(wrapper)

    expect(typeof overlayApplies).toBe('boolean')
    expect(overlayApplies || wrapperCancels).toBe(true)
    if (overlayApplies) {
      expect(wrapperCancels).toBe(true)
    }
  })

  it('cancels the filter on the same element the full-viewport overrides are on', () => {
    // The cancellation is only justified because this dialog covers the viewport and
    // paints over all of it. If the overrides that make it full-viewport ever go
    // away, the reasoning above no longer holds and this has to be revisited, so the
    // three of them are pinned together on one class list.
    const classList = wrapper.match(/const PREFERENCES_DIALOG_CLASSES = '([^']+)'/)
    expect(classList).not.toBeNull()
    const classes = (classList as RegExpMatchArray)[1].split(/\s+/)

    expect(classes).toContain('md:h-full')
    expect(classes).toContain('md:!max-h-full')
    expect(classes).toContain('md:!w-full')
    expect(classes).toContain('md:!backdrop-filter-none')

    // And that constant is what the dialog is actually given.
    expect(wrapper).toContain('className={PREFERENCES_DIALOG_CLASSES}')
  })

  it('does not disable translucent UI itself, which is a user preference', () => {
    // The fix removes a filter nobody can see. It must not also remove the
    // translucent background, which the user chose and which IS visible: screenshots
    // with and without it differ over 0.46% of the viewport.
    expect(overlay).toContain('md:bg-(--popover-background-color)')
    expect(wrapper).not.toContain('popover-background-color')
  })
})
