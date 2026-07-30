const MERMAID_MODULE_URL = 'https://cdn.jsdelivr.net/npm/mermaid@11.16.0/dist/mermaid.esm.min.mjs'

function installStylesheet() {
  if (document.querySelector('link[data-srn-mermaid-styles]')) {
    return
  }

  const stylesheet = document.createElement('link')
  stylesheet.rel = 'stylesheet'
  stylesheet.href = new URL('./mermaid.css', import.meta.url).href
  stylesheet.dataset.srnMermaidStyles = ''
  document.head.append(stylesheet)
}

function diagramContainerFor(code) {
  return code.closest('.highlighter-rouge') ?? code.closest('pre')
}

async function renderMermaidDiagrams() {
  const codeBlocks = [...document.querySelectorAll('code.language-mermaid')]
  if (codeBlocks.length === 0) {
    return
  }

  installStylesheet()

  try {
    const { default: mermaid } = await import(MERMAID_MODULE_URL)
    const darkMode = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: darkMode ? 'dark' : 'neutral',
    })

    for (const [index, code] of codeBlocks.entries()) {
      const source = code.textContent?.trim()
      const sourceContainer = diagramContainerFor(code)
      if (!source || !sourceContainer) {
        continue
      }

      try {
        const { svg, bindFunctions } = await mermaid.render(`srn-mermaid-${index + 1}`, source)
        const figure = document.createElement('figure')
        figure.className = 'docs-mermaid'
        figure.setAttribute('aria-label', 'Diagram')
        figure.innerHTML = svg
        sourceContainer.replaceWith(figure)
        bindFunctions?.(figure)
      } catch (error) {
        sourceContainer.classList.add('docs-mermaid-source-error')
        console.error('Unable to render Mermaid diagram; showing its source instead.', error)
      }
    }
  } catch (error) {
    console.error('Unable to load Mermaid; showing diagram source instead.', error)
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void renderMermaidDiagrams(), { once: true })
} else {
  void renderMermaidDiagrams()
}
