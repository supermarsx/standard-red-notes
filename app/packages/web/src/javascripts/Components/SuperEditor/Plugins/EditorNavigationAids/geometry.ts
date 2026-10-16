export type VisualLine = { top: number; height: number; left: number; right: number }

/** Formatting splits DOM text into spans: merge rectangles on the same visual baseline. */
export function mergeVisualLines(rectangles: VisualLine[]): VisualLine[] {
  const result: VisualLine[] = []
  for (const rect of [...rectangles].sort((a, b) => a.top - b.top || a.left - b.left)) {
    if (!(rect.height > 0) || rect.right < rect.left) {
      continue
    }
    const last = result.at(-1)
    const overlap = last ? Math.min(last.top + last.height, rect.top + rect.height) - Math.max(last.top, rect.top) : 0
    if (last && overlap >= Math.min(last.height, rect.height) * 0.5) {
      const bottom = Math.max(last.top + last.height, rect.top + rect.height)
      last.top = Math.min(last.top, rect.top)
      last.height = bottom - last.top
      last.left = Math.min(last.left, rect.left)
      last.right = Math.max(last.right, rect.right)
    } else {
      result.push({ ...rect })
    }
  }
  return result
}

/** Read-only Range geometry, once per text node rather than once per character. */
export function collectVisualLines(root: HTMLElement): VisualLine[] {
  const origin = root.getBoundingClientRect()
  const rectangles: VisualLine[] = []
  const append = (rect: DOMRect) => {
    if (rect.height > 0 && rect.width >= 0) {
      rectangles.push({
        top: rect.top - origin.top + root.scrollTop,
        height: rect.height,
        left: rect.left - origin.left + root.scrollLeft,
        right: rect.right - origin.left + root.scrollLeft,
      })
    }
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  let node: Node | null
  const excluded = (element: Element | null) => {
    const blocked = element?.closest('[contenteditable="false"], [aria-hidden="true"], [hidden]')
    // Read-only notes set contenteditable=false on the root itself; only nested
    // decorators are excluded. Their labels are not document text lines.
    return Boolean(blocked && blocked !== root && root.contains(blocked))
  }
  while ((node = walker.nextNode())) {
    if (!node.textContent || excluded(node.parentElement)) {
      continue
    }
    range.selectNodeContents(node)
    for (const rect of Array.from(range.getClientRects())) {
      append(rect)
    }
  }
  // Explicit empty soft lines (Shift+Enter) have no text node to measure.
  for (const br of Array.from(root.querySelectorAll('br'))) {
    if (excluded(br)) {
      continue
    }
    range.selectNode(br)
    for (const rect of Array.from(range.getClientRects())) {
      append(rect)
    }
  }
  // Empty paragraphs/list items still occupy a visual line. Decorator widgets do not.
  for (const block of Array.from(root.querySelectorAll('p,li,h1,h2,h3,h4,h5,h6,blockquote'))) {
    if (
      block.textContent?.trim() ||
      block.querySelector('p,li,[contenteditable="false"]') ||
      block.closest('[hidden],[aria-hidden="true"]')
    ) {
      continue
    }
    for (const rect of Array.from(block.getClientRects())) {
      append(rect)
    }
  }
  return mergeVisualLines(rectangles)
}

export function visibleLineStart(lines: VisualLine[], top: number): number {
  let low = 0,
    high = lines.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (lines[middle].top + lines[middle].height < top) {
      low = middle + 1
    } else {
      high = middle
    }
  }
  return low
}

export function minimapScrollTarget(fraction: number, contentHeight: number, viewportHeight: number): number {
  return Math.max(
    0,
    Math.min(
      Math.max(0, contentHeight - viewportHeight),
      Math.max(0, Math.min(1, fraction)) * contentHeight - viewportHeight / 2,
    ),
  )
}
