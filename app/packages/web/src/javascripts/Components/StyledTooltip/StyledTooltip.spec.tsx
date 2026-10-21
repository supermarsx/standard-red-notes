import { act } from 'react'
import { createRoot, Root } from 'react-dom/client'
import StyledTooltip from './StyledTooltip'

jest.mock('@/Hooks/useMediaQuery', () => ({
  MutuallyExclusiveMediaQueryBreakpoints: { sm: '(mobile)' },
  useMediaQuery: () => false,
}))

describe('StyledTooltip accessible names', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('names an icon control from a rich label before the tooltip opens', () => {
    act(() => {
      root.render(
        <StyledTooltip
          label={
            <span>
              Insert <strong>image</strong>
            </span>
          }
        >
          <button>
            <span aria-hidden="true">+</span>
          </button>
        </StyledTooltip>,
      )
    })
    const id = container.querySelector('button')!.getAttribute('aria-labelledby')!
    expect(document.getElementById(id)?.textContent).toBe('Insert image')
    expect(container.querySelector('[role="tooltip"]')).toBeNull()
  })

  it('preserves the explicit accessible name of the control', () => {
    act(() => {
      root.render(
        <StyledTooltip label="Extra help">
          <button aria-label="Insert image">+</button>
        </StyledTooltip>,
      )
    })
    expect(container.querySelector('button')?.getAttribute('aria-label')).toBe('Insert image')
    expect(container.querySelector('button')?.hasAttribute('aria-labelledby')).toBe(false)
  })

  it('does not replace the name when the tooltip is a description', () => {
    act(() => {
      root.render(
        <StyledTooltip label="Extra help" type="description">
          <button>Insert image</button>
        </StyledTooltip>,
      )
    })
    expect(container.querySelector('button')?.textContent).toBe('Insert image')
    expect(container.querySelector('button')?.hasAttribute('aria-labelledby')).toBe(false)
  })
})
