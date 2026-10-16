/** @jest-environment jsdom */
import katex from 'katex'
import { ensureMathHydrator, hydrateMathIn, mathPlaceholder } from './markdownMath'

jest.mock('katex', () => ({
  __esModule: true,
  default: { renderToString: jest.fn((tex: string) => `<span class="rendered-math">${tex}</span>`) },
}))

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeAll(() => ensureMathHydrator())
afterEach(async () => {
  document.body.replaceChildren()
  await settle()
  jest.clearAllMocks()
})

it('does not scan the entire document for unrelated streaming or editor DOM changes', async () => {
  const query = jest.spyOn(document, 'querySelector')
  const queryAll = jest.spyOn(document, 'querySelectorAll')
  try {
    const reply = document.createElement('div')
    document.body.appendChild(reply)
    for (let index = 0; index < 10; index++) {
      reply.appendChild(document.createTextNode(`word ${index} `))
      await settle()
    }
    expect(query).not.toHaveBeenCalled()
    expect(queryAll).not.toHaveBeenCalled()
    expect(katex.renderToString).not.toHaveBeenCalled()
  } finally {
    query.mockRestore()
    queryAll.mockRestore()
  }
})

it('hydrates an inserted placeholder itself and nested placeholders without duplicate in-flight renders', async () => {
  const root = document.createElement('div')
  root.innerHTML = mathPlaceholder('x', false) + `<section>${mathPlaceholder('y', true)}</section>`
  document.body.appendChild(root)
  hydrateMathIn(root)
  hydrateMathIn(root)
  await settle()
  expect(katex.renderToString).toHaveBeenCalledTimes(2)
  expect(root.querySelectorAll('[data-md-katex-tex]')).toHaveLength(0)
  const direct = document.createElement('div')
  direct.innerHTML = mathPlaceholder('z', false)
  document.body.appendChild(direct.firstElementChild!)
  await settle()
  expect(katex.renderToString).toHaveBeenCalledTimes(3)
  expect(katex.renderToString).toHaveBeenLastCalledWith('z', expect.objectContaining({ trust: false }))
})
