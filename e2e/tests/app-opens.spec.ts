import { test, expect, type ConsoleMessage } from '@playwright/test'

/**
 * "Does the app actually open?" — the most important regression to guard. A
 * broken bundle, a bootstrap exception, or a main-thread freeze (e.g. an
 * infinite Lexical DOM-mutation loop) all manifest as: the React shell never
 * renders. We load the real built app and assert the main UI appears, the page
 * stays responsive, and no fatal page error was thrown.
 */

// Console noise that is NOT a real failure (analytics/telemetry that's expected
// to be unconfigured in a local smoke run, favicon, etc.). Keep this tight.
const IGNORABLE_ERROR = /favicon|ResizeObserver loop|net::ERR_|web access|telemetry|Failed to load resource/i

test.describe('Standard Red Notes web app', () => {
  test('opens: the main UI renders and the page stays responsive', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))

    const consoleErrors: string[] = []
    page.on('console', (message: ConsoleMessage) => {
      if (message.type() === 'error' && !IGNORABLE_ERROR.test(message.text())) {
        consoleErrors.push(message.text())
      }
    })

    await page.goto('/', { waitUntil: 'domcontentloaded' })

    // The app mounts React into the body and renders the main shell. If it
    // hangs on load (frozen main thread) or throws during bootstrap, this never
    // appears and the expect times out — which is exactly the failure we want.
    await expect(page.locator('.main-ui-view, #footer-bar').first()).toBeVisible({ timeout: 30_000 })

    // Responsiveness probe: a frozen main thread can't run this evaluate, so a
    // hang that somehow rendered partial DOM still fails here.
    const title = await page.evaluate(() => document.title)
    expect(title.length).toBeGreaterThan(0)

    expect(pageErrors, `Uncaught page errors during bootstrap:\n${pageErrors.join('\n')}`).toEqual([])
    expect(consoleErrors, `Console errors during bootstrap:\n${consoleErrors.join('\n')}`).toEqual([])
  })

  test('the app root is mounted (body is not empty)', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    // React mounts into a root node it appends to <body>; a non-empty body with
    // real element children means the bundle ran far enough to render.
    await expect
      .poll(async () => page.evaluate(() => document.body.querySelectorAll('div').length), { timeout: 30_000 })
      .toBeGreaterThan(0)
  })

  test('opens fully styled: app.css is loaded and the shell has real layout', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(page.locator('.main-ui-view, #footer-bar').first()).toBeVisible({ timeout: 30_000 })

    // Guards against the "flash of unstyled content / never opens in full" bug:
    // the app stylesheet must actually be loaded AND the mounted root must have
    // computed layout from it (non-zero height), not render before CSS is ready.
    const styled = await page.evaluate(() => {
      const sheets = Array.from(document.styleSheets)
      const root = document.getElementById('app-group-root')
      return {
        sheetCount: sheets.length,
        hasAppCss: sheets.some((sheet) => (sheet.href ?? '').includes('app.css')),
        rootHeight: root ? Math.round(root.getBoundingClientRect().height) : 0,
      }
    })
    expect(styled.sheetCount, 'no stylesheets loaded').toBeGreaterThan(0)
    expect(styled.hasAppCss, 'app.css stylesheet not loaded').toBe(true)
    expect(styled.rootHeight, 'app root has no laid-out height (unstyled/blank)').toBeGreaterThan(0)

    // The default theme is represented by CSS custom properties. A production
    // Sass chunk once placed a UTF-8 BOM immediately before its :root selector,
    // which made every token undefined while the stylesheet and layout still
    // appeared loaded. Assert the rendered theme contract, not just the link.
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            getComputedStyle(document.documentElement).getPropertyValue('--sn-stylekit-theme-name').trim(),
          ),
        {
          timeout: 30_000,
          message: 'Standard Red theme tokens never became active',
        },
      )
      .toBe('sn-standard-red')

    const theme = await page.evaluate(() => {
      const parseColor = (value: string): [number, number, number] | undefined => {
        const hex = value.trim().match(/^#([\da-f]{6})$/i)?.[1]
        if (hex) {
          return [
            Number.parseInt(hex.slice(0, 2), 16),
            Number.parseInt(hex.slice(2, 4), 16),
            Number.parseInt(hex.slice(4, 6), 16),
          ]
        }

        const rgb = value.match(/^rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)/i)
        return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : undefined
      }
      const luminance = (color: [number, number, number]): number => {
        const channels = color.map((channel) => {
          const normalized = channel / 255
          return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
        })
        return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
      }
      const contrast = (first: [number, number, number], second: [number, number, number]): number => {
        const lighter = Math.max(luminance(first), luminance(second))
        const darker = Math.min(luminance(first), luminance(second))
        return (lighter + 0.05) / (darker + 0.05)
      }

      const rootStyle = getComputedStyle(document.documentElement)
      const bodyStyle = getComputedStyle(document.body)
      const shell = document.querySelector<HTMLElement>('.main-ui-view')
      const shellStyle = shell ? getComputedStyle(shell) : undefined
      const backgroundToken = rootStyle.getPropertyValue('--sn-stylekit-background-color').trim()
      const foregroundToken = rootStyle.getPropertyValue('--sn-stylekit-foreground-color').trim()
      const accentToken = rootStyle.getPropertyValue('--sn-stylekit-info-color').trim()
      const background = parseColor(backgroundToken)
      const foreground = parseColor(foregroundToken)
      const accent = parseColor(accentToken)
      const renderedBackground = parseColor(bodyStyle.backgroundColor)
      const renderedShellBackground = shellStyle ? parseColor(shellStyle.backgroundColor) : undefined
      const renderedShellForeground = shellStyle ? parseColor(shellStyle.color) : undefined

      return {
        themeType: rootStyle.getPropertyValue('--sn-stylekit-theme-type').trim(),
        backgroundToken,
        foregroundToken,
        accentToken,
        renderedBodyBackground: bodyStyle.backgroundColor,
        renderedShellBackground: shellStyle?.backgroundColor,
        renderedShellForeground: shellStyle?.color,
        backgroundLuminance: background ? luminance(background) : undefined,
        renderedBackgroundLuminance: renderedBackground ? luminance(renderedBackground) : undefined,
        renderedShellBackgroundLuminance: renderedShellBackground ? luminance(renderedShellBackground) : undefined,
        renderedShellForegroundContrast:
          renderedShellBackground && renderedShellForeground
            ? contrast(renderedShellBackground, renderedShellForeground)
            : undefined,
        foregroundContrast: background && foreground ? contrast(background, foreground) : undefined,
        accentContrast: background && accent ? contrast(background, accent) : undefined,
      }
    })

    expect(theme.themeType).toBe('dark')
    expect(theme.backgroundToken).toMatch(/^#[\da-f]{6}$/i)
    expect(theme.foregroundToken).toMatch(/^#[\da-f]{6}$/i)
    expect(theme.accentToken).toMatch(/^#[\da-f]{6}$/i)
    expect(theme.renderedBodyBackground).not.toBe('rgba(0, 0, 0, 0)')
    expect(theme.renderedShellBackground).not.toBe('rgba(0, 0, 0, 0)')
    expect(theme.renderedShellForeground).toBeDefined()
    expect(theme.backgroundLuminance).toBeLessThan(0.08)
    expect(theme.renderedBackgroundLuminance).toBeLessThan(0.08)
    expect(theme.renderedShellBackgroundLuminance).toBeLessThan(0.08)
    expect(theme.renderedShellForegroundContrast).toBeGreaterThanOrEqual(7)
    expect(theme.foregroundContrast).toBeGreaterThanOrEqual(7)
    expect(theme.accentContrast).toBeGreaterThanOrEqual(4.5)
  })
})
