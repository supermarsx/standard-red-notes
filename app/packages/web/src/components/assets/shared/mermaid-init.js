/* eslint-disable */
// Renders ```mermaid fenced code blocks inside the legacy markdown editors'
// preview panes. These editors are prebuilt third-party iframe bundles, so we
// inject this (plus mermaid.min.js) rather than rebuilding them. Best-effort:
// it watches the DOM and converts mermaid code blocks to live diagrams.
(function () {
  function ready(fn) {
    if (document.readyState !== 'loading') fn()
    else document.addEventListener('DOMContentLoaded', fn)
  }

  ready(function () {
    if (!window.mermaid) return
    try {
      var dark =
        typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
      window.mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: dark ? 'dark' : 'default',
        fontFamily: 'inherit',
      })
    } catch (e) {}

    var seq = 0
    var KEYWORDS =
      /^\s*(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|gantt|pie|mindmap|timeline|gitGraph|journey|quadrantChart|requirementDiagram|C4Context|sankey|xychart)\b/

    function render(targetEl, code) {
      var src = (code || '').trim()
      if (!src) return
      try {
        var id = 'mmd-' + seq++
        window.mermaid
          .render(id, src)
          .then(function (res) {
            var div = document.createElement('div')
            div.className = 'mermaid-rendered'
            div.setAttribute('data-mermaid-rendered', '1')
            div.innerHTML = res.svg
            if (targetEl && targetEl.parentNode) targetEl.replaceWith(div)
          })
          .catch(function () {})
      } catch (e) {}
    }

    function scan(root) {
      if (!root || !root.querySelectorAll) return
      // Explicit mermaid-tagged code blocks.
      root
        .querySelectorAll('code.language-mermaid, code.lang-mermaid, .mermaid:not([data-mermaid-rendered])')
        .forEach(function (el) {
          if (el.__mmdDone) return
          el.__mmdDone = true
          render(el.closest('pre') || el, el.textContent || '')
        })
      // Heuristic: a <pre><code> whose first line is a mermaid diagram keyword.
      root.querySelectorAll('pre > code').forEach(function (el) {
        if (el.__mmdDone) return
        var t = el.textContent || ''
        if (KEYWORDS.test(t)) {
          el.__mmdDone = true
          render(el.closest('pre'), t)
        }
      })
    }

    try {
      var mo = new MutationObserver(function () {
        scan(document.body)
      })
      mo.observe(document.body, { childList: true, subtree: true })
    } catch (e) {}
    scan(document.body)
  })
})()
