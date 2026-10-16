import fs from 'node:fs'
import path from 'node:path'

const css = fs.readFileSync(
  path.resolve(__dirname, '../../../../../../src/components/assets/com.sncommunity.lights-out-theme/dist/theme.css'),
  'utf8',
)
const tokens = new Map([...css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]))
function color(name: string): string {
  const value = tokens.get(name)!
  return value.startsWith('var(') ? color(value.slice(4, -1)) : value
}
function luminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/../g)!
    .map((channel) => {
      const n = parseInt(channel, 16) / 255
      return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4
    })
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}
function contrast(a: string, b: string): number {
  const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y)
  return (high + 0.05) / (low + 0.05)
}

describe('Lights Out control contrast', () => {
  it('keeps muted text and button outlines visible on both black surfaces', () => {
    for (const surface of ['--background-primary', '--background-secondary']) {
      expect(contrast(color('--text-secondary'), color(surface))).toBeGreaterThanOrEqual(4.5)
      expect(contrast(color('--sn-stylekit-passive-color-2'), color(surface))).toBeGreaterThanOrEqual(4.5)
      expect(contrast(color('--sn-stylekit-border-color'), color(surface))).toBeGreaterThanOrEqual(3)
    }
  })

  it('uses legible colors without a second opacity reduction for native and reason-bearing disabled buttons', () => {
    expect(css).toMatch(
      /button:disabled,\s*button\[aria-disabled='true'\]\s*\{[^}]*color: var\(--text-secondary\);[^}]*background-color: var\(--background-secondary\);[^}]*border-color: var\(--border-subtle\);[^}]*opacity: 1;/,
    )
  })
})
