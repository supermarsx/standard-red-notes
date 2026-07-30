(() => {
  'use strict'

  const sidebar = document.querySelector('[data-docs-sidebar]')
  const sidebarToggle = document.querySelector('[data-docs-nav-toggle]')

  const setSidebarOpen = (open) => {
    if (!sidebar || !sidebarToggle) {
      return
    }
    sidebar.classList.toggle('is-open', open)
    sidebarToggle.setAttribute('aria-expanded', String(open))
    sidebarToggle.querySelector('[data-docs-nav-toggle-label]').textContent = open ? 'Close docs' : 'Browse docs'
  }

  sidebarToggle?.addEventListener('click', () => setSidebarOpen(!sidebar.classList.contains('is-open')))
  sidebar?.addEventListener('click', (event) => {
    if (event.target.closest('a') && window.matchMedia('(max-width: 900px)').matches) {
      setSidebarOpen(false)
    }
  })

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && sidebar?.classList.contains('is-open')) {
      setSidebarOpen(false)
      sidebarToggle?.focus()
    }
  })

  const normalizePathname = (pathname) => pathname.replace(/\/index\.html$/, '/').replace(/\/+$/, '') || '/'

  const activateCurrentNavigationLink = () => {
    const links = [...document.querySelectorAll('[data-docs-nav-link]')]
    const currentPath = normalizePathname(window.location.pathname)
    const currentHash = decodeURIComponent(window.location.hash)
    let currentLink = null

    for (const link of links) {
      const target = new URL(link.href, window.location.href)
      const isCurrentPath = normalizePathname(target.pathname) === currentPath
      const isCurrentAnchor = decodeURIComponent(target.hash) === currentHash
      const isCurrent = isCurrentPath && isCurrentAnchor
      link.toggleAttribute('aria-current', isCurrent)
      if (isCurrent) {
        link.setAttribute('aria-current', target.hash ? 'location' : 'page')
        currentLink = link
      }
    }

    if (!currentLink && currentHash) {
      currentLink = links.find((link) => {
        const target = new URL(link.href, window.location.href)
        return normalizePathname(target.pathname) === currentPath && !target.hash
      })
      currentLink?.setAttribute('aria-current', 'page')
    }

    for (
      let details = currentLink?.closest('details[data-docs-nav-details]');
      details;
      details = details.parentElement?.closest('details[data-docs-nav-details]')
    ) {
      details.open = true
    }
  }

  activateCurrentNavigationLink()
  window.addEventListener('hashchange', activateCurrentNavigationLink)

  const pageTableOfContents = document.querySelector('[data-docs-page-toc]')
  const articleHeadings = [
    ...document.querySelectorAll('.docs-content article h2, .docs-content article h3, .docs-content article h4'),
  ]

  if (pageTableOfContents && articleHeadings.length > 1) {
    const details = document.createElement('details')
    details.className = 'docs-page-toc'
    details.open = true

    const summary = document.createElement('summary')
    summary.textContent = 'On this page'
    const list = document.createElement('ol')

    const linksByHeading = new Map()
    for (const heading of articleHeadings) {
      const explicitAnchor =
        heading.previousElementSibling?.tagName === 'A' ? heading.previousElementSibling.getAttribute('id') : null
      if (!heading.id && !explicitAnchor) {
        heading.id = heading.textContent
          .normalize('NFKD')
          .replace(/\p{Mark}/gu, '')
          .toLocaleLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/(^-|-$)/g, '')
      }
      const anchor = explicitAnchor || heading.id
      if (!anchor) {
        continue
      }

      const item = document.createElement('li')
      item.className = `docs-page-toc__level-${heading.tagName.slice(1)}`
      const link = document.createElement('a')
      link.href = `#${encodeURIComponent(anchor)}`
      link.textContent = heading.textContent
      item.append(link)
      list.append(item)
      linksByHeading.set(heading, link)
    }

    details.append(summary, list)
    pageTableOfContents.append(details)

    const activateHeading = (heading) => {
      for (const link of linksByHeading.values()) {
        link.removeAttribute('aria-current')
      }
      linksByHeading.get(heading)?.setAttribute('aria-current', 'location')
    }

    const initialHeading =
      articleHeadings.find((heading) => {
        const explicitAnchor =
          heading.previousElementSibling?.tagName === 'A' ? heading.previousElementSibling.getAttribute('id') : null
        return `#${explicitAnchor || heading.id}` === decodeURIComponent(window.location.hash)
      }) ?? articleHeadings[0]
    activateHeading(initialHeading)

    if ('IntersectionObserver' in window) {
      const visibleHeadings = new Map()
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              visibleHeadings.set(entry.target, entry.boundingClientRect.top)
            } else {
              visibleHeadings.delete(entry.target)
            }
          }
          const nearest = [...visibleHeadings.entries()].sort((left, right) => left[1] - right[1])[0]?.[0]
          if (nearest) {
            activateHeading(nearest)
          }
        },
        { rootMargin: '0px 0px -72% 0px', threshold: [0, 1] },
      )
      articleHeadings.forEach((heading) => observer.observe(heading))
    }
  }

  const installCopyButton = (pre) => {
    const code = pre.querySelector('code')
    if (!code || code.classList.contains('language-mermaid')) {
      return
    }

    let container = pre.closest('.highlighter-rouge')
    if (!container) {
      container = document.createElement('div')
      pre.before(container)
      container.append(pre)
    }
    if (container.querySelector(':scope > .docs-copy-button')) {
      return
    }

    container.classList.add('docs-code-block')
    const button = document.createElement('button')
    button.className = 'docs-copy-button'
    button.type = 'button'
    button.textContent = 'Copy'
    button.setAttribute('aria-label', 'Copy code snippet')
    button.addEventListener('click', async () => {
      try {
        const source = code.textContent ?? ''
        if (navigator.clipboard?.writeText && window.isSecureContext) {
          await navigator.clipboard.writeText(source)
        } else {
          const selection = window.getSelection()
          const previousRanges = selection ? [...Array(selection.rangeCount)].map((_, index) => selection.getRangeAt(index)) : []
          const range = document.createRange()
          range.selectNodeContents(code)
          selection?.removeAllRanges()
          selection?.addRange(range)
          if (!document.execCommand('copy')) {
            throw new Error('The browser rejected the copy command')
          }
          selection?.removeAllRanges()
          previousRanges.forEach((previousRange) => selection?.addRange(previousRange))
        }
        button.textContent = 'Copied'
        button.setAttribute('aria-label', 'Code snippet copied')
        window.setTimeout(() => {
          button.textContent = 'Copy'
          button.setAttribute('aria-label', 'Copy code snippet')
        }, 1600)
      } catch (error) {
        console.error('Unable to copy the code snippet.', error)
        button.textContent = 'Select to copy'
        const range = document.createRange()
        range.selectNodeContents(code)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
      }
    })
    container.prepend(button)
  }

  document.querySelectorAll('.docs-content pre').forEach(installCopyButton)
})()
