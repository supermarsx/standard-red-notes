import fs from 'node:fs'
import path from 'node:path'

const webRoot = path.resolve(__dirname, '../../../../../../')

const sources = {
  base: path.resolve(webRoot, '../styles/src/Styles/_colors.scss'),
  theme: path.resolve(webRoot, 'src/components/assets/org.standardnotes.theme-standard-red/index.css'),
  bridge: path.resolve(webRoot, 'src/components/assets/shared/sn-theme-bridge.css'),
}

function propertiesFrom(filePath: string): Map<string, string> {
  const source = fs.readFileSync(filePath, 'utf8')
  const properties = new Map<string, string>()

  for (const match of source.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    properties.set(match[1], match[2].trim())
  }

  return properties
}

function channelToLinear(channel: number): number {
  const normalized = channel / 255
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
}

function luminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/../g)
    ?.map((channel) => channelToLinear(Number.parseInt(channel, 16)))

  if (!channels || channels.length !== 3) {
    throw new Error(`Expected an opaque six-digit hex color, received ${hex}`)
  }

  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

function contrastRatio(first: string, second: string): number {
  const firstLuminance = luminance(first)
  const secondLuminance = luminance(second)
  return (Math.max(firstLuminance, secondLuminance) + 0.05) / (Math.min(firstLuminance, secondLuminance) + 0.05)
}

function color(properties: Map<string, string>, name: string): string {
  const value = properties.get(name)
  if (!value) {
    throw new Error(`Missing Standard Red token ${name}`)
  }
  return value
}

describe('Standard Red theme contract', () => {
  const base = propertiesFrom(sources.base)
  const theme = propertiesFrom(sources.theme)
  const bridge = propertiesFrom(sources.bridge)
  const coreTokens = [...base.keys()].filter(
    (name) =>
      ['--foreground-color', '--background-color', '--highlight-color', '--border-color'].includes(name) ||
      name.startsWith('--sn-component-') ||
      name.startsWith('--sn-stylekit-') ||
      name.startsWith('--sn-desktop-'),
  )

  it('keeps the base, first-class asset, and component bridge in exact token parity', () => {
    expect(coreTokens.length).toBeGreaterThanOrEqual(55)

    for (const token of coreTokens) {
      expect(theme.get(token)).toBe(base.get(token))
      expect(bridge.get(token)).toBe(base.get(token))
    }
  })

  it('stays unmistakably dark with a progressive burgundy surface hierarchy', () => {
    expect(color(base, '--sn-stylekit-theme-type')).toBe('dark')
    expect(color(base, '--sn-stylekit-theme-name')).toBe('sn-standard-red')
    expect(color(base, '--sn-stylekit-background-color')).toBe('#16090f')
    expect(color(base, '--sn-stylekit-info-color')).toBe('#e85f6d')

    expect(
      [
        '--sn-stylekit-background-color',
        '--sn-stylekit-editor-background-color',
        '--sn-stylekit-secondary-background-color',
        '--sn-stylekit-contrast-background-color',
        '--sn-stylekit-secondary-contrast-background-color',
      ].map((token) => color(base, token)),
    ).toEqual(['#16090f', '#190b11', '#200c14', '#241019', '#321520'])

    expect(color(base, '--sn-stylekit-foreground-color')).not.toBe('#ffffff')
    expect(color(base, '--sn-stylekit-contrast-foreground-color')).not.toBe('#ffffff')
  })

  it('meets normal-text contrast across every theme surface', () => {
    const surfaces = [
      '--sn-stylekit-background-color',
      '--sn-stylekit-editor-background-color',
      '--sn-stylekit-secondary-background-color',
      '--sn-stylekit-contrast-background-color',
      '--sn-stylekit-secondary-contrast-background-color',
    ].map((token) => color(base, token))

    const normalTextTokens = [
      '--sn-stylekit-info-color',
      '--sn-stylekit-foreground-color',
      '--sn-stylekit-contrast-foreground-color',
      '--sn-stylekit-secondary-foreground-color',
      '--sn-stylekit-secondary-contrast-foreground-color',
      '--sn-stylekit-paragraph-text-color',
      '--sn-stylekit-input-placeholder-color',
      '--sn-stylekit-passive-color-0',
      '--sn-stylekit-passive-color-1',
      '--sn-stylekit-passive-color-2',
    ]

    for (const token of normalTextTokens) {
      for (const surface of surfaces) {
        expect(contrastRatio(color(base, token), surface)).toBeGreaterThanOrEqual(4.5)
      }
    }

    const controlBoundaryTokens = ['--border-color', '--sn-stylekit-border-color', '--sn-stylekit-input-border-color']

    for (const token of controlBoundaryTokens) {
      for (const surface of surfaces) {
        expect(contrastRatio(color(base, token), surface)).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it('gives every filled semantic color an accessible contrast color', () => {
    const semanticPairs = [
      ['--sn-stylekit-neutral-color', '--sn-stylekit-neutral-contrast-color'],
      ['--sn-stylekit-info-color', '--sn-stylekit-info-contrast-color'],
      ['--sn-stylekit-info-color-darkened', '--sn-stylekit-info-contrast-color'],
      ['--sn-stylekit-success-color', '--sn-stylekit-success-contrast-color'],
      ['--sn-stylekit-warning-color', '--sn-stylekit-warning-contrast-color'],
      ['--sn-stylekit-danger-color', '--sn-stylekit-danger-contrast-color'],
    ]

    for (const [backgroundToken, foregroundToken] of semanticPairs) {
      expect(contrastRatio(color(base, backgroundToken), color(base, foregroundToken))).toBeGreaterThanOrEqual(4.5)
    }
  })
})
