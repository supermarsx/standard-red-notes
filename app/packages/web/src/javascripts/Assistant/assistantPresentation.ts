/**
 * Human-facing labels for assistant tool activity and approvals. Tool names and
 * arguments are an implementation protocol; they should not leak straight into
 * the chat UI or a decision the user has to make.
 */

export type AssistantToolConfirmation = {
  name: string
  args: Record<string, unknown>
  /** Opaque local correlation id; never displayed or sent to the provider. */
  callId?: string
}

export type AssistantToolPresentation = {
  label: string
  detail?: string
}

export type AssistantConfirmationPresentation = AssistantToolPresentation & {
  title: string
  confirmButtonText: string
  confirmButtonStyle?: 'danger' | 'info'
  fields: AssistantConfirmationField[]
  /** True when the bounded card omits or truncates material action input. */
  reviewIncomplete: boolean
}

export type AssistantConfirmationField = {
  label: string
  value: string
}

const MAX_VALUE_LENGTH = 280
const MAX_FIELDS = 6
const SENSITIVE_FIELD = /(password|secret|token|api[_-]?key|authorization|credential|cookie)/i
const BODY_FIELD = /^(text|markdown|body|content|message)$/i
const TARGET_FIELDS = ['targetTitle', 'targetShortId', 'targetTagTitle', 'targetTagShortId'] as const

const humanize = (value: string) =>
  value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase())

const truncate = (value: string, max = MAX_VALUE_LENGTH) => {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value
}

function presentValueWithCompleteness(key: string, value: unknown): { value: string; complete: boolean } {
  if (SENSITIVE_FIELD.test(key)) {
    return { value: '[hidden]', complete: false }
  }
  if (typeof value === 'string') {
    const normalized = value.replace(/\s+/g, ' ').trim()
    return { value: truncate(normalized) || '(empty)', complete: normalized.length <= MAX_VALUE_LENGTH }
  }
  if (value === null) {
    return { value: 'None', complete: true }
  }
  if (typeof value === 'undefined') {
    return { value: 'Not set', complete: true }
  }
  if (typeof value === 'object') {
    try {
      const serialized = JSON.stringify(value)
      return { value: truncate(serialized), complete: serialized.length <= MAX_VALUE_LENGTH }
    } catch {
      return { value: '[unavailable]', complete: false }
    }
  }
  const serialized = String(value)
  return { value: truncate(serialized), complete: serialized.length <= MAX_VALUE_LENGTH }
}

function presentValue(key: string, value: unknown): string {
  return presentValueWithCompleteness(key, value).value
}

function confirmationFields(args: Record<string, unknown>): {
  fields: AssistantConfirmationField[]
  reviewIncomplete: boolean
} {
  const visible = Object.entries(args).filter(([key]) => key !== 'uuid' && key !== 'noteUuid' && key !== 'tagUuid')
  const priorities = TARGET_FIELDS.flatMap((targetKey) => {
    const match = visible.find(([key]) => key === targetKey)
    return match ? [match] : []
  })
  const remaining = visible.filter(([key]) => !TARGET_FIELDS.includes(key as (typeof TARGET_FIELDS)[number]))
  const ordered = [...priorities, ...remaining]
  const shown = ordered.slice(0, MAX_FIELDS).map(([key, value]) => {
    const presented = presentValueWithCompleteness(key, value)
    return { field: { label: humanize(key), value: presented.value }, complete: presented.complete }
  })
  return {
    fields: shown.map(({ field }) => field),
    reviewIncomplete: ordered.length > MAX_FIELDS || shown.some(({ complete }) => !complete),
  }
}

function fieldsDetail(args: Record<string, unknown>, includeBody = true): string | undefined {
  const entries = Object.entries(args).filter(
    ([key]) => (includeBody || !BODY_FIELD.test(key)) && key !== 'uuid' && key !== 'noteUuid' && key !== 'tagUuid',
  )
  if (entries.length === 0) {
    return undefined
  }
  const shown = entries.slice(0, MAX_FIELDS).map(([key, value]) => `${humanize(key)}: ${presentValue(key, value)}`)
  if (entries.length > MAX_FIELDS) {
    shown.push(`+${entries.length - MAX_FIELDS} more details`)
  }
  return shown.join(' • ')
}

/** A concise, friendly status card for an in-flight or completed tool call. */
export function describeAssistantTool(name: string, rawArgs: unknown): AssistantToolPresentation {
  const args = isRecord(rawArgs) ? rawArgs : {}
  const title =
    typeof args.title === 'string' && args.title.trim() ? `“${truncate(args.title.trim(), 100)}”` : undefined

  switch (name) {
    case 'notes.create':
    case 'notes.createSuper':
      return { label: 'Creating a note', detail: title ? `New note ${title}` : 'Preparing a new note' }
    case 'notes.update':
    case 'notes.updateSuper':
      return { label: 'Updating a note', detail: title ? `Updating ${title}` : 'Applying the requested note changes' }
    case 'notes.patchBlocks':
      return { label: 'Patching note blocks', detail: 'Applying a bounded structural edit to the selected note.' }
    case 'notes.delete':
      return { label: 'Deleting a note', detail: 'This permanently removes the selected note.' }
    case 'tags.create':
      return { label: 'Creating a tag', detail: title ? `New tag ${title}` : undefined }
    case 'tags.assign':
      return { label: 'Adding a tag to a note', detail: 'Organizing the selected note.' }
    case 'tags.unassign':
      return { label: 'Removing a tag from a note', detail: 'Updating the selected note’s organization.' }
    case 'app.setPreference':
      return { label: 'Updating an app preference', detail: fieldsDetail(args) }
    case 'app.setTheme':
      return {
        label: 'Changing the theme',
        detail: typeof args.theme === 'string' ? `Theme: ${presentValue('theme', args.theme)}` : undefined,
      }
    case 'app.noteAction':
      return { label: `${humanize(String(args.action ?? 'note'))} a note`, detail: 'Updating the note’s status.' }
    case 'reminders.set':
      return { label: 'Setting a reminder', detail: fieldsDetail(args) }
    case 'reminders.clear':
      return { label: 'Clearing reminders', detail: 'Removing every reminder from the selected note.' }
    case 'configure_achievements':
      return { label: 'Updating achievement settings', detail: fieldsDetail(args) }
    case 'notes.search':
    case 'notes.retrieve':
      return {
        label: 'Searching your notes',
        detail: typeof args.query === 'string' ? `Looking for: ${presentValue('query', args.query)}` : undefined,
      }
    case 'notes.read':
    case 'notes.readSuper':
    case 'notes.readBlocks':
      return { label: 'Reading a note', detail: 'Reviewing the selected note.' }
    case 'notes.list':
      return { label: 'Reviewing your notes' }
    case 'tags.list':
      return { label: 'Reviewing your tags' }
    case 'app.openNote':
      return { label: 'Opening a note' }
    case 'app.navigate':
      return {
        label: 'Navigating the app',
        detail: typeof args.target === 'string' ? `Opening ${humanize(args.target)}` : undefined,
      }
    case 'todo.write':
      return { label: 'Updating the task plan' }
    case 'web.search':
      return {
        label: 'Searching the web',
        detail: typeof args.query === 'string' ? `Looking for: ${presentValue('query', args.query)}` : undefined,
      }
    case 'web.fetch':
      return { label: 'Reading a web page' }
    case 'delegate':
      return {
        label: 'Working on a focused subtask',
        detail: typeof args.task === 'string' ? presentValue('task', args.task) : undefined,
      }
    default:
      return { label: 'Working on your request' }
  }
}

/** Format an approval prompt without exposing raw tool protocol or unbounded note text. */
export function describeAssistantToolConfirmation({
  name,
  args,
}: AssistantToolConfirmation): AssistantConfirmationPresentation {
  const presentation = describeAssistantTool(name, args)
  const destructive = isIrreversibleAssistantTool({ name, args })
  const { fields, reviewIncomplete } = confirmationFields(args)
  return {
    title: destructive ? 'Confirm assistant action' : 'Allow assistant action',
    confirmButtonText: destructive ? 'Allow change' : 'Allow',
    confirmButtonStyle: destructive ? 'danger' : 'info',
    ...presentation,
    fields,
    reviewIncomplete,
  }
}

/**
 * Destructive operations retain an explicit approval even if the user has
 * allowed a reversible action for the rest of this chat. This is deliberately
 * deterministic; model output never decides the safety boundary.
 */
export function isIrreversibleAssistantTool({ name, args }: AssistantToolConfirmation): boolean {
  return (
    name === 'notes.delete' ||
    name === 'reminders.clear' ||
    args.action === 'trash' ||
    (name === 'configure_achievements' && args.setting === 'reset')
  )
}

export function formatAssistantConfirmationText(presentation: AssistantConfirmationPresentation): string {
  return [
    presentation.label,
    presentation.detail,
    ...presentation.fields.map((field) => `${field.label}: ${field.value}`),
  ]
    .filter(Boolean)
    .join(' — ')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
