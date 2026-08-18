import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8')

describe('no-preview illustration theme contract', () => {
  it('uses semantic currentColor fills and a CSP-safe theme shadow in light and dark themes', () => {
    const svg = read('../../../../../icons/src/Icons/il-no-preview.svg')
    const lightTheme = read('../../../components/assets/org.standardnotes.theme-standard-notes-blue/index.css')
    const darkTheme = read('../../../components/assets/org.standardnotes.theme-standard-red/index.css')

    expect(svg).toContain('class="text-contrast"')
    expect(svg).toContain('class="text-passive-2"')
    expect(svg).toContain('class="text-default"')
    expect(svg.match(/fill="currentColor"/g)).toHaveLength(3)
    expect(svg).toContain('var(--sn-stylekit-shadow-color, #000000)')

    expect(svg).not.toMatch(/fill="#F4F5F7"|fill="#BBBEC4"|fill="white"/i)
    expect(svg).not.toMatch(/<style\b|\sstyle=/i)

    for (const theme of [lightTheme, darkTheme]) {
      expect(theme).toContain('--sn-stylekit-contrast-background-color:')
      expect(theme).toContain('--sn-stylekit-passive-color-2:')
      expect(theme).toContain('--sn-stylekit-background-color:')
      expect(theme).toContain('--sn-stylekit-shadow-color:')
    }
  })
})
