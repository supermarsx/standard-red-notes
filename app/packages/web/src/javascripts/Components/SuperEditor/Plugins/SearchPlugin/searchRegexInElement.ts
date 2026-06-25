/**
 * Searches an element for all matches of a (global) RegExp and returns DOM `Range`s for
 * highlighting, mirroring the output shape of `searchInElement`.
 *
 * Limitation: matches are computed per text node, so a match that spans more than one
 * text node (e.g. across formatting boundaries / inline element splits) will not be
 * found. This is a deliberate, documented best-effort trade-off for regex mode — literal
 * search continues to use `searchInElement` which supports cross-node matches.
 */
export function searchRegexInElement(element: HTMLElement, regex: RegExp): Range[] {
  const ranges: Range[] = []

  // Ensure the regex is global so exec() iterates; clone with the g flag if missing.
  const flags = regex.flags.includes('g') ? regex.flags : regex.flags + 'g'
  const globalRegex = new RegExp(regex.source, flags)

  const walk = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null)
  let node = walk.nextNode()

  while (node) {
    const text = node.textContent
    if (!text) {
      node = walk.nextNode()
      continue
    }

    globalRegex.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = globalRegex.exec(text)) !== null) {
      // Guard against zero-length matches causing an infinite loop.
      if (match[0].length === 0) {
        globalRegex.lastIndex++
        continue
      }
      const start = match.index
      const end = start + match[0].length
      const range = new Range()
      range.setStart(node, start)
      range.setEnd(node, end)
      ranges.push(range)
    }

    node = walk.nextNode()
  }

  return ranges
}
