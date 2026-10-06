/** @jest-environment jsdom */
import { readFileSync } from 'fs'
import { join } from 'path'
import { act } from 'react'
import { createRoot, Root } from 'react-dom/client'

import { SHARED_VIEW_ROOT_ATTRIBUTE, useSharedViewThemeContext } from './useSharedViewThemeContext'

/**
 * The share page has no signed-in user, so `ThemeManager` never runs and no
 * theme stylesheet is ever installed. Measured in headless Chrome with freshly
 * compiled stylesheets (`dist/app.css` is stale JIT output and was not used),
 * the page therefore resolved the base palette — theme-type `dark`,
 * background `#16090f` — identically whether the browser asked for
 * `prefers-color-scheme: dark` or `light`.
 *
 * Since d3a6469f that is not only a look: `MermaidAppTheme.readMermaidAppTheme`
 * derives a diagram palette from those same properties, read off
 * `document.documentElement`. So the two things that must hold are (1) the
 * marker lands on the ROOT element, not on the view, and (2) the light palette
 * is COMPLETE — a token left behind keeps its dark value on a light page.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const STYLESHEETS = join(__dirname, '..', '..', '..', 'stylesheets')
const BASE_PALETTE = join(__dirname, '..', '..', '..', '..', '..', 'styles', 'src', 'Styles', '_colors.scss')
const SHARE_PALETTE = join(STYLESHEETS, '_shared-view.scss')

const tokensIn = (source: string): Set<string> => {
  const found = new Set<string>()
  for (const match of source.matchAll(/(--sn-stylekit-[a-z0-9-]+)\s*:/g)) {
    found.add(match[1])
  }
  return found
}

const Host = () => {
  useSharedViewThemeContext()
  return <div>shared</div>
}

describe('the share page declares itself a theme context', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('marks the document ROOT, which is where the palette has to be readable', async () => {
    // A class on the view would style the page and still hand every mermaid
    // diagram the palette it replaced, because the diagram reads
    // getComputedStyle(document.documentElement).
    expect(document.documentElement.hasAttribute(SHARED_VIEW_ROOT_ATTRIBUTE)).toBe(false)
    await act(async () => {
      root.render(<Host />)
      await Promise.resolve()
    })
    expect(document.documentElement.hasAttribute(SHARED_VIEW_ROOT_ATTRIBUTE)).toBe(true)
  })

  it('takes the marker away again, so the authenticated app is never affected', async () => {
    await act(async () => {
      root.render(<Host />)
      await Promise.resolve()
    })
    await act(async () => root.render(<div />))
    expect(document.documentElement.hasAttribute(SHARED_VIEW_ROOT_ATTRIBUTE)).toBe(false)
  })
})

describe('the share page light palette', () => {
  const base = readFileSync(BASE_PALETTE, 'utf8')
  const share = readFileSync(SHARE_PALETTE, 'utf8')

  it('is scoped to the share marker on :root and to a light OS preference', () => {
    expect(share).toContain('@media (prefers-color-scheme: light)')
    expect(share).toContain(`:root[${SHARED_VIEW_ROOT_ATTRIBUTE}]`)
  })

  it('redeclares every stylekit token the base palette declares', () => {
    // A token left out keeps its DARK value on a light page: the half-themed
    // surface that reads as a rendering bug. This fails the moment the base
    // palette grows a token the share palette has not been told about.
    const missing = [...tokensIn(base)].filter((token) => !tokensIn(share).has(token)).sort()
    expect(missing).toEqual([])
  })

  it('declares a light theme type whose background is actually light', () => {
    // `declaredThemeTypeToTrust` DISCARDS a declared theme type that disagrees
    // with the luminance of the colour the theme paints, so a mismatch here
    // would not be obeyed — it would be ignored, and the diagram and the page
    // would disagree about which theme they are in.
    expect(share).toMatch(/--sn-stylekit-theme-type:\s*light/)
    const background = /--sn-stylekit-background-color:\s*(#[0-9a-f]{3,8})/i.exec(share)?.[1]
    expect(background).toBeDefined()
    const hex = (background as string).slice(1)
    const value = parseInt(hex.length === 3 ? hex.replace(/./g, '$&$&') : hex.slice(0, 6), 16)
    const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((channel) => {
      const normalized = channel / 255
      return normalized <= 0.03928 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4)
    })
    const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
    expect(luminance).toBeGreaterThan(0.5)
  })

  it('is reached by the app stylesheet', () => {
    expect(readFileSync(join(STYLESHEETS, 'index.css.scss'), 'utf8')).toContain("@import 'shared-view'")
  })
})
