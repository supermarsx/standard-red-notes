(() => {
  'use strict'

  const resultLimit = 12

  const normalize = (value) =>
    String(value)
      .normalize('NFKD')
      .replace(/\p{Mark}/gu, '')
      .toLocaleLowerCase()
      .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
      .trim()

  const queryTerms = (query) => [...new Set(normalize(query).split(/\s+/).filter(Boolean))]

  const countOccurrences = (haystack, needle) => {
    let count = 0
    let position = 0
    while ((position = haystack.indexOf(needle, position)) !== -1) {
      count++
      position += needle.length
    }
    return count
  }

  const scoreDocument = (document, normalizedQuery, terms) => {
    const title = normalize(document.title)
    const section = normalize(document.section)
    const text = normalize(document.text)
    const searchable = `${title} ${section} ${text}`
    if (!terms.every((term) => searchable.includes(term))) {
      return null
    }

    let score = document.section ? 8 : 0
    if (title === normalizedQuery) score += 240
    else if (title.startsWith(normalizedQuery)) score += 150
    else if (title.includes(normalizedQuery)) score += 100

    if (section === normalizedQuery) score += 220
    else if (section.startsWith(normalizedQuery)) score += 130
    else if (section.includes(normalizedQuery)) score += 90

    if (text.includes(normalizedQuery)) score += 35

    for (const term of terms) {
      if (title.split(' ').includes(term)) score += 42
      else if (title.includes(term)) score += 22
      if (section.split(' ').includes(term)) score += 38
      else if (section.includes(term)) score += 20
      score += Math.min(8, countOccurrences(text, term)) * 3
    }
    return score
  }

  const rankDocuments = (sourceDocuments, query, limit = resultLimit) => {
    const normalizedQuery = normalize(query)
    const terms = queryTerms(query)
    if (!normalizedQuery || terms.length === 0 || !sourceDocuments) {
      return []
    }

    const ranked = sourceDocuments
      .map((document, order) => ({
        document,
        order,
        score: scoreDocument(document, normalizedQuery, terms),
      }))
      .filter((result) => result.score !== null)
      .sort((left, right) => right.score - left.score || left.order - right.order)

    const selected = []
    const overflow = []
    const resultsPerPage = new Map()
    for (const result of ranked) {
      const page = result.document.url.split('#', 1)[0]
      const count = resultsPerPage.get(page) ?? 0
      if (count < 3) {
        selected.push(result)
        resultsPerPage.set(page, count + 1)
      } else {
        overflow.push(result)
      }
    }

    return selected.length >= limit ? selected.slice(0, limit) : [...selected, ...overflow].slice(0, limit)
  }

  const snippetFor = (text, query) => {
    const source = String(text || '')
    const terms = queryTerms(query)
    const lowered = source.toLocaleLowerCase()
    const phrase = String(query).trim().toLocaleLowerCase()
    let matchPosition = phrase ? lowered.indexOf(phrase) : -1
    if (matchPosition === -1) {
      matchPosition = terms.reduce((earliest, term) => {
        const position = lowered.indexOf(term)
        return position !== -1 && (earliest === -1 || position < earliest) ? position : earliest
      }, -1)
    }
    if (matchPosition === -1) {
      matchPosition = 0
    }

    const maximumLength = 190
    let start = Math.max(0, matchPosition - 68)
    let end = Math.min(source.length, start + maximumLength)
    if (start > 0) {
      const nextSpace = source.indexOf(' ', start)
      start = nextSpace === -1 || nextSpace >= matchPosition ? start : nextSpace + 1
    }
    if (end < source.length) {
      const previousSpace = source.lastIndexOf(' ', end)
      end = previousSpace <= start ? end : previousSpace
    }
    return `${start > 0 ? '…' : ''}${source.slice(start, end).trim()}${end < source.length ? '…' : ''}`
  }

  if (globalThis.__SRN_DOCS_SEARCH_TEST__) {
    Object.assign(globalThis.__SRN_DOCS_SEARCH_TEST__, {
      normalize,
      queryTerms,
      rankDocuments,
      snippetFor,
    })
  }

  if (typeof document === 'undefined') {
    return
  }
  const root = document.querySelector('[data-docs-search]')
  if (!root) {
    return
  }

  const trigger = root.querySelector('[data-search-trigger]')
  const dialog = root.querySelector('[data-search-dialog]')
  const input = root.querySelector('[data-search-input]')
  const closeButton = root.querySelector('[data-search-close]')
  const status = root.querySelector('[data-search-status]')
  const resultsList = root.querySelector('[data-search-results]')
  const shortcut = root.querySelector('[data-search-shortcut]')
  const indexUrl = root.dataset.searchIndexUrl
  const baseUrl = new URL(root.dataset.searchBaseUrl || './', window.location.href)

  if (!trigger || !dialog || !input || !closeButton || !status || !resultsList || !indexUrl) {
    return
  }

  let documents = null
  let indexPromise = null
  let activeResult = -1

  const appendHighlightedText = (element, text, terms) => {
    const uniqueTerms = [...new Set(terms)].sort((left, right) => right.length - left.length)
    if (uniqueTerms.length === 0) {
      element.textContent = text
      return
    }

    const escaped = uniqueTerms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    const matcher = new RegExp(`(${escaped.join('|')})`, 'giu')
    let position = 0
    for (const match of String(text).matchAll(matcher)) {
      element.append(document.createTextNode(String(text).slice(position, match.index)))
      const highlight = document.createElement('mark')
      highlight.textContent = match[0]
      element.append(highlight)
      position = match.index + match[0].length
    }
    element.append(document.createTextNode(String(text).slice(position)))
  }

  const setActiveResult = (index, focus = false) => {
    const links = [...resultsList.querySelectorAll('a')]
    if (links.length === 0) {
      activeResult = -1
      return
    }
    activeResult = (index + links.length) % links.length
    links.forEach((link, linkIndex) => {
      link.classList.toggle('is-active', linkIndex === activeResult)
      link.setAttribute('aria-current', linkIndex === activeResult ? 'true' : 'false')
    })
    if (focus) {
      links[activeResult].focus()
    }
  }

  const renderResults = (query) => {
    const terms = queryTerms(query)
    const ranked = rankDocuments(documents, query)
    resultsList.replaceChildren()
    activeResult = -1

    if (!query.trim()) {
      status.textContent = 'Type a word or phrase to search all documentation.'
      return
    }
    if (ranked.length === 0) {
      status.textContent = `No documentation matched “${query.trim()}”.`
      return
    }

    status.textContent = `${ranked.length} result${ranked.length === 1 ? '' : 's'} for “${query.trim()}”.`
    for (const { document: result } of ranked) {
      const item = document.createElement('li')
      const link = document.createElement('a')
      link.href = new URL(result.url, baseUrl).href

      const title = document.createElement('span')
      title.className = 'docs-search-result-title'
      appendHighlightedText(title, result.title, terms)

      const section = document.createElement('span')
      section.className = 'docs-search-result-section'
      appendHighlightedText(section, result.section || 'Page overview', terms)

      const snippet = document.createElement('span')
      snippet.className = 'docs-search-result-snippet'
      appendHighlightedText(snippet, snippetFor(result.text, query), terms)

      link.append(title, section, snippet)
      item.append(link)
      resultsList.append(item)
    }
    setActiveResult(0)
  }

  const loadIndex = () => {
    if (indexPromise) {
      return indexPromise
    }
    status.textContent = 'Loading the documentation index…'
    indexPromise = fetch(indexUrl, { credentials: 'same-origin' })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Search index request failed with ${response.status}`)
        }
        return response.json()
      })
      .then((index) => {
        if (index.version !== 1 || !Array.isArray(index.documents)) {
          throw new Error('Search index has an unsupported format')
        }
        documents = index.documents
        renderResults(input.value)
      })
      .catch((error) => {
        indexPromise = null
        console.error('Documentation search failed to load.', error)
        status.textContent = 'Search is temporarily unavailable. You can still browse the navigation links.'
        throw error
      })
    return indexPromise
  }

  const openSearch = () => {
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') {
        dialog.showModal()
      } else {
        dialog.setAttribute('open', '')
      }
    }
    input.focus()
    input.select()
    void loadIndex().catch(() => {})
  }

  const closeSearch = () => {
    if (!dialog.open) {
      return
    }
    if (typeof dialog.close === 'function') {
      dialog.close()
    } else {
      dialog.removeAttribute('open')
    }
    trigger.focus()
  }

  const isTypingTarget = (target) =>
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName))

  trigger.hidden = false
  if (/Mac|iPhone|iPad/.test(navigator.platform)) {
    shortcut.textContent = '⌘ K'
  }

  trigger.addEventListener('click', openSearch)
  trigger.addEventListener('pointerenter', () => void loadIndex().catch(() => {}), { once: true })
  closeButton.addEventListener('click', closeSearch)
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault()
    closeSearch()
  })
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      closeSearch()
    }
  })
  input.addEventListener('input', () => {
    if (documents) {
      renderResults(input.value)
    }
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' && resultsList.childElementCount > 0) {
      event.preventDefault()
      setActiveResult(0, true)
    } else if (event.key === 'Enter') {
      const firstResult = resultsList.querySelector('a')
      if (firstResult) {
        event.preventDefault()
        firstResult.click()
      }
    }
  })
  resultsList.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveResult(activeResult + (event.key === 'ArrowDown' ? 1 : -1), true)
    }
  })
  document.addEventListener('keydown', (event) => {
    const commandShortcut = (event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'k'
    const slashShortcut = event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey
    if (commandShortcut || (slashShortcut && !isTypingTarget(event.target))) {
      event.preventDefault()
      openSearch()
    }
  })
})()
