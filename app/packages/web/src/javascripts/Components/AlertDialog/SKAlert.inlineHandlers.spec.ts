/**
 * @jest-environment jsdom
 */

/**
 * SKAlert builds its markup as a STRING and hands it to innerHTML. That makes it
 * one of the few places in this app where JSX habits are silently wrong: an
 * `onClick={closeDialog}` written in a template literal does not interpolate, it
 * ships literally, and the HTML parser lowercases it to `onclick` with
 * `{closeDialog}` as the handler body. The browser then refuses to run it under
 * `script-src-attr` and reports a CSP violation on every dialog with a title.
 *
 * That is not hypothetical: it shipped, it was live, and the sha256 of
 * `{closeDialog}` is the exact hash the deployment's CSP had been pinning.
 *
 * These assertions are over the DOM SKAlert actually produces, not over the
 * source text, so they keep holding however the markup is spelled.
 */

import { SKAlert } from '@standardnotes/styles/src/Alert/Alert'

const inlineHandlerAttributes = (root: ParentNode): string[] => {
  const found: string[] = []
  root.querySelectorAll('*').forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name.toLowerCase().startsWith('on')) {
        found.push(`${element.tagName.toLowerCase()}[${attribute.name}="${attribute.value}"]`)
      }
    }
  })
  return found
}

describe('SKAlert inline event handlers', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('presents a dialog whose markup carries NO inline event-handler attribute', () => {
    const alert = new SKAlert({
      title: 'Some title',
      text: 'Some text',
      buttons: [{ text: 'OK', style: 'info', primary: true }],
    })

    alert.present()

    // Control: the assertion below is only meaningful while the close button is
    // actually rendered. If it ever stops rendering, this fails loudly rather
    // than letting the real assertion pass vacuously.
    expect(document.querySelector('#close-button')).not.toBeNull()

    expect(inlineHandlerAttributes(document.body)).toEqual([])
  })

  it('closes the dialog when the close button is clicked', () => {
    const alert = new SKAlert({ title: 'Some title', text: 'Some text' })

    alert.present()
    expect(document.querySelector('.sk-modal')).not.toBeNull()

    const closeButton = document.querySelector<HTMLButtonElement>('#close-button')
    expect(closeButton).not.toBeNull()
    closeButton?.click()

    expect(document.querySelector('.sk-modal')).toBeNull()
  })

  it('still runs a button action and dismisses when an action button is clicked', () => {
    const action = jest.fn()
    const alert = new SKAlert({
      title: 'Some title',
      text: 'Some text',
      buttons: [{ text: 'OK', style: 'info', primary: true, action }],
    })

    alert.present()
    document.querySelector<HTMLButtonElement>('#button-0')?.click()

    expect(action).toHaveBeenCalledTimes(1)
    expect(document.querySelector('.sk-modal')).toBeNull()
  })

  it('renders no close button, and still no inline handler, without a title', () => {
    const alert = new SKAlert({ text: 'Some text' })

    alert.present()

    expect(document.querySelector('#close-button')).toBeNull()
    expect(inlineHandlerAttributes(document.body)).toEqual([])
  })
})
