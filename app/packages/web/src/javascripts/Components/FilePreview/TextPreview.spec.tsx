/**
 * @jest-environment jsdom
 */
import { TextDecoder as NodeTextDecoder, TextEncoder as NodeTextEncoder } from 'util'
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import TextPreview from './TextPreview'
import { MAX_HIGHLIGHT_BYTES } from './textPreviewContent'

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const codecGlobal = globalThis as unknown as { TextEncoder?: unknown; TextDecoder?: unknown }
if (!codecGlobal.TextEncoder) {
  codecGlobal.TextEncoder = NodeTextEncoder
}
if (!codecGlobal.TextDecoder) {
  codecGlobal.TextDecoder = NodeTextDecoder
}

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('TextPreview', () => {
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

  function renderText(text: string, fileName: string, mimeType: string): void {
    act(() => {
      root.render(
        createElement(TextPreview, {
          bytes: new TextEncoder().encode(text),
          fileName,
          mimeType,
        }),
      )
    })
  }

  it('renders an OpenVPN profile in a read-only highlighted editor', () => {
    renderText(
      'client\nremote vpn.example.test 1194\n<ca>\ncertificate\n</ca>',
      'work.ovpn',
      'application/octet-stream',
    )

    const editor = container.querySelector('[role="textbox"]')
    expect(editor?.getAttribute('aria-readonly')).toBe('true')
    expect(container.querySelector('[data-token-kind="keyword"]')?.textContent).toBe('client')
    expect(container.querySelector('[data-token-kind="tag"]')?.textContent).toBe('<ca>')
    expect(container.textContent).toContain('OpenVPN')
  })

  it('renders hostile markup only as escaped React text', () => {
    renderText('<script>globalThis.compromised = true</script>', 'example.html', 'text/html')

    expect(container.querySelector('script')).toBeNull()
    expect(container.textContent).toContain('<script>')
    expect((globalThis as { compromised?: boolean }).compromised).toBeUndefined()
  })

  it('allows syntax highlighting and line wrapping to be toggled', () => {
    renderText('client\nremote vpn.example.test', 'work.ovpn', 'application/x-openvpn-profile')
    const syntaxButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'textPreviewSyntax',
    )
    const wrapButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'textPreviewWrap',
    )

    act(() => syntaxButton?.click())
    const textarea = container.querySelector('textarea')
    expect(textarea).not.toBeNull()
    expect(textarea?.readOnly).toBe(true)
    expect(textarea?.value).toBe('client\nremote vpn.example.test')

    act(() => wrapButton?.click())
    expect(textarea?.getAttribute('wrap')).toBe('off')
  })

  it('falls back to the plain read-only editor when highlighting would be expensive', () => {
    renderText(`client ${'a'.repeat(MAX_HIGHLIGHT_BYTES)}`, 'large.ovpn', 'application/octet-stream')

    const syntaxButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'textPreviewSyntax',
    )
    expect(syntaxButton?.hasAttribute('disabled')).toBe(true)
    expect(container.querySelector('textarea')?.readOnly).toBe(true)
    expect(container.querySelector('[data-token-kind]')).toBeNull()
  })

  it('refuses malformed UTF-8 without exposing a partial preview', () => {
    act(() => {
      root.render(
        createElement(TextPreview, {
          bytes: new Uint8Array([0xc3, 0x28]),
          fileName: 'broken.txt',
          mimeType: 'text/plain',
        }),
      )
    })

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('textPreviewInvalidText')
    expect(container.querySelector('textarea')).toBeNull()
  })

  it('forces left-to-right display and exposes bidi controls as visible markers', () => {
    renderText('safe\u202eevil', 'profile\u2067.ovpn', 'application/octet-stream')

    const editor = container.querySelector('[role="textbox"]')
    expect(editor?.getAttribute('dir')).toBe('ltr')
    expect(container.textContent).toContain('[U+202E RIGHT-TO-LEFT OVERRIDE]')
    expect(container.textContent).toContain('[U+2067 RIGHT-TO-LEFT ISOLATE]')
    expect(container.querySelector('[role="status"]')?.textContent).toBe('textPreviewBidiControlsNeutralized')
  })
})
