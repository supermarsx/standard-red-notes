import { PredicateJsonForm, PredicateOperator } from '@standardnotes/snjs'
import { PredicateKeypath, PredicateKeypathLabels, PredicateKeypathTypes } from './PredicateKeypaths'

/**
 * Pure, side-effect-free helpers that translate the low-level predicate model
 * (keypaths + raw operator symbols like "=", ">", "includes") into a friendly,
 * plain-language vocabulary for the guided Smart View builder.
 *
 * Nothing in this module renders UI or touches the application — it only maps
 * data, so it can be unit tested in isolation and keeps the React components
 * thin. The output always serializes back to the same PredicateJsonForm the
 * model already understands, so backward compatibility is preserved.
 */

export type PredicateFieldType = (typeof PredicateKeypathTypes)[PredicateKeypath]

/* -------------------------------------------------------------------------- */
/* Field picker: human labels, descriptions, and category grouping            */
/* -------------------------------------------------------------------------- */

export type FieldOption = {
  keypath: PredicateKeypath
  label: string
  description: string
}

export type FieldGroup = {
  label: string
  fields: FieldOption[]
}

/** Short, plain-language explanation of what each field means. */
const FieldDescriptions: { [k in PredicateKeypath]: string } = {
  title: 'The note or file title',
  text: 'The full body text of the note',
  pinned: 'Whether the note is pinned to the top',
  starred: 'Whether the note is starred',
  archived: 'Whether the note is archived',
  protected: 'Whether the note is protected (needs auth to view)',
  trashed: 'Whether the note is in the trash',
  locked: 'Whether the note is locked from editing',
  created_at: 'The date the note was created',
  userModifiedDate: 'The date you last edited the note',
  serverUpdatedAt: 'The date the note last synced to the server',
  noteType: 'The kind of note (Plain, Super, Markdown, etc.)',
  editorIdentifier: 'The specific editor assigned to the note',
  'title.length': 'The number of characters in the title',
  'text.length': 'The number of characters in the body text',
  conflict_of: 'Whether the note is a conflicted copy of another note',
  hidePreview: 'Whether the note preview is hidden in the list',
  spellcheck: 'Whether spellcheck is enabled for the note',
}

/** Ordered category groups shown as <optgroup>s in the field picker. */
const FIELD_GROUPS: { label: string; keypaths: PredicateKeypath[] }[] = [
  { label: 'Content', keypaths: ['title', 'text'] },
  { label: 'Status', keypaths: ['pinned', 'starred', 'archived', 'protected', 'trashed', 'locked'] },
  { label: 'Dates', keypaths: ['created_at', 'userModifiedDate', 'serverUpdatedAt'] },
  { label: 'Type', keypaths: ['noteType', 'editorIdentifier'] },
  { label: 'Advanced', keypaths: ['title.length', 'text.length', 'conflict_of', 'hidePreview', 'spellcheck'] },
]

export const getFieldGroups = (): FieldGroup[] =>
  FIELD_GROUPS.map((group) => ({
    label: group.label,
    fields: group.keypaths.map((keypath) => ({
      keypath,
      label: PredicateKeypathLabels[keypath],
      description: FieldDescriptions[keypath],
    })),
  }))

export const getFieldDescription = (keypath: PredicateKeypath): string => FieldDescriptions[keypath] ?? ''

/* -------------------------------------------------------------------------- */
/* Boolean fields rendered as a plain statement + Yes/No control              */
/* -------------------------------------------------------------------------- */

const BooleanStatements: Partial<{ [k in PredicateKeypath]: string }> = {
  pinned: 'Is pinned',
  starred: 'Is starred',
  archived: 'Is archived',
  protected: 'Is protected',
  trashed: 'Is in the trash',
  locked: 'Is locked',
  hidePreview: 'Hides its preview',
  spellcheck: 'Has spellcheck on',
}

export const booleanStatementLabel = (keypath: PredicateKeypath): string =>
  BooleanStatements[keypath] ?? PredicateKeypathLabels[keypath]

/** Normalizes a stored predicate value (boolean or "true"/"false") to a boolean. */
export const booleanValueIsTrue = (value: unknown): boolean => value === true || value === 'true'

/* -------------------------------------------------------------------------- */
/* Friendly operators, mapped per field type                                  */
/* -------------------------------------------------------------------------- */

export type FriendlyOperator = {
  operator: PredicateOperator
  label: string
  /** Optional longer explanation, e.g. for the advanced regex option. */
  hint?: string
}

/**
 * Maps the raw operator symbols to human phrases appropriate for the field
 * type. Raw symbols ("=", ">", "includes") are never surfaced in the guided
 * path. Booleans and dates use dedicated controls, so they are handled
 * separately (see booleanStatementLabel and the date helpers below).
 */
export const friendlyOperatorsForType = (type: PredicateFieldType): FriendlyOperator[] => {
  switch (type) {
    case 'string':
      return [
        { operator: 'includes', label: 'contains' },
        { operator: '=', label: 'is exactly' },
        { operator: 'startsWith', label: 'starts with' },
        { operator: '!=', label: 'is not' },
        { operator: 'matches', label: 'matches (regex, advanced)', hint: 'Matches a regular expression' },
      ]
    case 'number':
      return [
        { operator: '>', label: 'is more than' },
        { operator: '<', label: 'is less than' },
        { operator: '=', label: 'equals' },
      ]
    case 'noteType':
    case 'editorIdentifier':
      return [
        { operator: '=', label: 'is' },
        { operator: '!=', label: 'is not' },
      ]
    case 'date':
      return [
        { operator: '>', label: 'is after' },
        { operator: '<', label: 'is before' },
      ]
    case 'boolean':
      return [{ operator: '=', label: 'is' }]
  }
}

export const defaultOperatorForType = (type: PredicateFieldType): PredicateOperator =>
  friendlyOperatorsForType(type)[0].operator

/* -------------------------------------------------------------------------- */
/* Friendly relative-date helper                                              */
/* -------------------------------------------------------------------------- */

/**
 * Relative-date presets. Each `value` is a date DSL string in exactly the form
 * the model's predicate date parser accepts ("N.days.ago", "N.years.ago" —
 * verified against Predicate.spec.ts / dateFromDSLDateString). Combined with
 * the ">" operator these read as "the field is after N ago", i.e. "in the last
 * N".
 */
export type RelativeDateOption = {
  id: string
  label: string
  value: string
}

export const RelativeDateOptions: RelativeDateOption[] = [
  { id: 'today', label: 'Today', value: '1.days.ago' },
  { id: 'last7', label: 'In the last 7 days', value: '7.days.ago' },
  { id: 'last30', label: 'In the last 30 days', value: '30.days.ago' },
  { id: 'last90', label: 'In the last 90 days', value: '90.days.ago' },
  { id: 'thisYear', label: 'In the last year', value: '1.years.ago' },
]

export const DEFAULT_RELATIVE_DATE_VALUE = '7.days.ago'

/** True when a value is a relative "N.unit.ago" DSL string. */
export const isRelativeDateValue = (value: unknown): boolean => typeof value === 'string' && value.includes('.ago')

export type DateMode = 'inLast' | 'after' | 'before'

/**
 * Derives which of the three date UI modes a stored predicate represents, so
 * the builder can show the right control without keeping extra state:
 *  - "<"                       -> before an exact date
 *  - ">" with a relative value -> in the last N (relative)
 *  - ">" with an exact value   -> after an exact date
 */
export const dateModeFromPredicate = (operator: PredicateOperator, value: unknown): DateMode => {
  if (operator === '<') {
    return 'before'
  }
  if (isRelativeDateValue(value)) {
    return 'inLast'
  }
  return 'after'
}

/** YYYY-MM-DD string suitable for an <input type="date"> value. */
export const toDateInputValue = (date = new Date()): string => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** The predicate {operator, value} pair a given date mode should produce. */
export const predicatePartsForDateMode = (mode: DateMode): { operator: PredicateOperator; value: string } => {
  switch (mode) {
    case 'inLast':
      return { operator: '>', value: DEFAULT_RELATIVE_DATE_VALUE }
    case 'after':
      return { operator: '>', value: toDateInputValue() }
    case 'before':
      return { operator: '<', value: toDateInputValue() }
  }
}

/* -------------------------------------------------------------------------- */
/* Builder compatibility for quick-start templates                            */
/* -------------------------------------------------------------------------- */

const isSupportedKeypath = (keypath: unknown): keypath is PredicateKeypath =>
  typeof keypath === 'string' && keypath in PredicateKeypathTypes

/**
 * Whether a predicate can be represented by the guided builder's simple rows.
 * Compound "and"/"or" predicates are compatible when every leaf is compatible.
 * A leaf is compatible when its keypath is one of the supported simple fields
 * and its value is a scalar (nested predicate objects — e.g. `tags includes
 * {...}` — are not editable as a simple row and are excluded).
 */
export const isBuilderCompatiblePredicate = (json: PredicateJsonForm): boolean => {
  if (json.operator === 'and' || json.operator === 'or') {
    return (
      Array.isArray(json.value) &&
      json.value.length > 0 &&
      json.value.every((child) => isBuilderCompatiblePredicate(child as PredicateJsonForm))
    )
  }

  return isSupportedKeypath(json.keypath) && json.value !== null && typeof json.value !== 'object'
}
