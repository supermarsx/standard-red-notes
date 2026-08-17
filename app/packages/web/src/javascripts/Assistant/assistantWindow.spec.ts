/** @jest-environment jsdom */

describe('assistant pop-out ownership', () => {
  beforeEach(() => {
    jest.resetModules()
  })
  afterEach(() => jest.restoreAllMocks())

  it('reports a blocked popup so the docked owner can remain open', () => {
    jest.spyOn(window, 'open').mockReturnValueOnce(null)
    const { openOrFocusAssistantWindow } = require('./assistantWindow') as typeof import('./assistantWindow')
    expect(openOrFocusAssistantWindow()).toBe(false)
  })

  it('reports success and reuses the existing popup', () => {
    const popup = { closed: false, focus: jest.fn() } as unknown as Window
    const open = jest.spyOn(window, 'open').mockReturnValueOnce(popup)
    const { openOrFocusAssistantWindow } = require('./assistantWindow') as typeof import('./assistantWindow')

    expect(openOrFocusAssistantWindow()).toBe(true)
    expect(openOrFocusAssistantWindow()).toBe(true)
    expect(open).toHaveBeenCalledTimes(1)
    expect(popup.focus).toHaveBeenCalledTimes(2)
  })
})
