import { NoteType } from '@standardnotes/snjs'

export type AssistantChecklistItem = {
  text: string
  checked: boolean | null
  completionMode: 'single' | 'per-person'
  checkedBy?: string[]
  checkedByTruncated?: boolean
  checkedForCurrentUser?: boolean
  todoId?: string
}
type Projection = { text: string; items: AssistantChecklistItem[]; status: 'parsed' | 'unknown'; truncated: boolean }
const MAX_INPUT = 1_000_000
const MAX_ITEMS = 200
const record = (value: unknown): Record<string, unknown> | undefined => {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
const marker = (item: AssistantChecklistItem) => {
  return item.completionMode === 'per-person'
    ? '[per-person]'
    : item.checked === null
      ? '[?]'
      : item.checked
        ? '[x]'
        : '[ ]'
}

export function serializedChecklistCompletion(
  node: Record<string, unknown>,
  selfUuid?: string,
): Omit<AssistantChecklistItem, 'text' | 'todoId'> {
  const state = record(node.$) ?? {}
  const personal = state.srnChecklistPerPerson === true
  const ticks = Object.entries(state)
    .filter(([key, value]) => /^srnChecklistTick_[A-Za-z0-9-]{1,96}$/.test(key) && value === true)
    .map(([key]) => key.slice('srnChecklistTick_'.length))
    .sort()
  return {
    checked: personal ? null : typeof node.checked === 'boolean' ? node.checked : null,
    completionMode: personal ? 'per-person' : 'single',
    ...(personal
      ? {
          checkedBy: ticks.slice(0, 64),
          checkedByTruncated: ticks.length > 64,
          ...(selfUuid ? { checkedForCurrentUser: ticks.includes(selfUuid) } : {}),
        }
      : {}),
  }
}

/** Bounded, read-only projection of persisted states; absence is never an unchecked verdict. */
export function projectNoteChecklist(text: string, noteType?: NoteType, selfUuid?: string): Projection {
  const result: Projection = { text: '', items: [], status: 'parsed', truncated: false }
  if (text.length > MAX_INPUT) {
    return { text: text.slice(0, MAX_INPUT), items: [], status: 'unknown', truncated: true }
  }
  const add = (item: AssistantChecklistItem): string => {
    if (item.text.length > 500) {
      result.truncated = true
    }
    if (result.items.length < MAX_ITEMS) {
      result.items.push({ ...item, text: item.text.slice(0, 500) })
    } else {
      result.truncated = true
    }
    return `${marker(item)} ${item.text}`
  }
  if (noteType === NoteType.RichText) {
    // Template contents stay inert and are never attached: no scripts, images or links are loaded.
    if (typeof document === 'undefined') {
      return { ...result, text, status: 'unknown' }
    }
    const template = document.createElement('template')
    template.innerHTML = text
    template.content.querySelectorAll('script,style,iframe,object,embed').forEach((node) => node.remove())
    const rows = Array.from(template.content.querySelectorAll('li')).slice(0, 1000)
    for (const row of rows) {
      const own = row.cloneNode(true) as HTMLElement
      own.querySelectorAll('ul,ol').forEach((node) => node.remove())
      const box = own.querySelector<HTMLInputElement>('input[type="checkbox"]')
      const state = own.getAttribute('data-checked') ?? row.parentElement?.getAttribute('data-checked')
      const listState = own.getAttribute('data-list')
      const checked = box
        ? box.hasAttribute('checked')
        : state === 'true' || listState === 'checked'
          ? true
          : state === 'false' || listState === 'unchecked'
            ? false
            : undefined
      if (checked !== undefined) {
        const label = own.textContent?.trim() ?? ''
        if (label) {
          const line = add({ text: label, checked, completionMode: 'single' })
          row.insertBefore(document.createTextNode(`${line}\n`), row.firstChild)
          Array.from(row.childNodes)
            .slice(1)
            .filter((node) => !(node instanceof HTMLElement && ['UL', 'OL'].includes(node.tagName)))
            .forEach((node) => node.remove())
        }
      }
    }
    result.text = template.content.textContent ?? ''
    // Third-party rich editors have no universal task schema; unsupported rows remain unknown.
    result.status = 'unknown'
    return result
  }
  if (noteType === NoteType.Code || noteType === NoteType.Spreadsheet || noteType === NoteType.Authentication) {
    return { ...result, text, status: noteType === NoteType.Code ? 'parsed' : 'unknown' }
  }
  if (noteType !== NoteType.Super && noteType !== NoteType.Task) {
    let fence: string | undefined
    result.text = text
      .split('\n')
      .map((line) => {
        const delimiter = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]
        if (delimiter) {
          if (!fence) {
            fence = delimiter
          } else if (fence[0] === delimiter[0] && delimiter.length >= fence.length) {
            fence = undefined
          }
          return line
        }
        const task = !fence && /^\s*(?:[-+*]|\d+[.)])\s+\[([ xX])\]\s+(.*)$/.exec(line)
        if (task) {
          add({ text: task[2], checked: task[1] !== ' ', completionMode: 'single' })
        }
        return line
      })
      .join('\n')
    return result
  }
  let parsed: Record<string, unknown> | undefined
  try {
    parsed = record(JSON.parse(text))
  } catch {
    return { ...result, status: 'unknown' }
  }
  if (!parsed) {
    return { ...result, status: 'unknown' }
  }
  if (noteType === NoteType.Task) {
    const groups = Array.isArray(parsed.groups) ? parsed.groups.map(record) : [{ tasks: parsed.tasks }]
    const lines: string[] = []
    let recognized = Array.isArray(parsed.groups) || Array.isArray(parsed.tasks)
    for (const group of groups.slice(0, 1000)) {
      if (!group || !Array.isArray(group.tasks)) {
        recognized = false
        continue
      }
      for (const raw of group.tasks.slice(0, 1000)) {
        const task = record(raw)
        if (!task || typeof task.description !== 'string') {
          result.status = 'unknown'
          continue
        }
        lines.push(
          add({
            text: task.description,
            checked: typeof task.completed === 'boolean' ? task.completed : null,
            completionMode: 'single',
          }),
        )
      }
      if (group.tasks.length > 1000) {
        result.truncated = true
      }
    }
    result.text = lines.join('\n')
    result.status = recognized ? result.status : 'unknown'
    if (groups.length > 1000) {
      result.truncated = true
    }
    return result
  }
  let remaining = 50_000
  const visit = (raw: unknown, depth: number, inCheckList = false, labelOnly = false): string => {
    const node = record(raw)
    if (!node || depth > 128 || --remaining < 0) {
      result.truncated = true
      return ''
    }
    if (typeof node.text === 'string') {
      return node.text
    }
    if (node.type === 'linebreak') {
      return '\n'
    }
    const children = Array.isArray(node.children) ? node.children : []
    if (labelOnly && node.type === 'list') {
      return ''
    }
    if (node.type === 'listitem' && inCheckList && !labelOnly) {
      const state = record(node.$) ?? {}
      const label = children.map((child) => visit(child, depth + 1, false, true)).join('')
      const nested = children.filter((child) => record(child)?.type === 'list').map((child) => visit(child, depth + 1))
      // A nesting-only wrapper and a recurrence summary are not checkable work.
      if (!label.trim() || state.srnChecklistOccurrenceSummary !== undefined) {
        return [label, ...nested].filter(Boolean).join('\n')
      }
      const item: AssistantChecklistItem = {
        text: label,
        ...serializedChecklistCompletion(node, selfUuid),
        ...(typeof state.srnChecklistTodoId === 'string' ? { todoId: state.srnChecklistTodoId.slice(0, 128) } : {}),
      }
      return [add(item), ...nested].join('\n')
    }
    return children
      .map((child) => visit(child, depth + 1, node.type === 'list' && node.listType === 'check', labelOnly))
      .join(['root', 'list'].includes(String(node.type)) ? '\n' : '')
  }
  if (!record(parsed.root) || !Array.isArray(record(parsed.root)?.children)) {
    return { ...result, status: 'unknown' }
  }
  result.text = visit(parsed.root, 0)
  return result
}

/** Search and passage tools disclose only labels already present in their preview/snippet. */
export function checklistForPassage(projection: Projection, passage: string) {
  return {
    status: projection.status,
    scope: 'passage' as const,
    truncated: projection.truncated,
    items: projection.items.filter((item) => item.text.length > 0 && passage.includes(item.text)),
  }
}

export function checklistForNote(projection: Projection) {
  return { status: projection.status, scope: 'note' as const, truncated: projection.truncated, items: projection.items }
}
