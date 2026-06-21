import { predicateFromJson, PredicateJsonForm } from '@standardnotes/snjs'

/**
 * A copy-paste-able example predicate that a user can insert into the custom
 * JSON predicate field with a single click. Every preset here is verified to
 * parse with the real `predicateFromJson` parser (see PredicateGuidance.spec.ts).
 */
export type PredicatePreset = {
  label: string
  description: string
  predicate: PredicateJsonForm
}

/**
 * Build the list of preset predicates. A factory is used so callers that need a
 * tag-specific example can pass the tag title the user is interested in.
 */
export const getPredicatePresets = (exampleTagTitle = 'todo'): PredicatePreset[] => [
  {
    label: 'Notes with no topics',
    description: 'Matches notes that have not been assigned any topics.',
    predicate: {
      keypath: 'tags',
      operator: 'includes',
      value: {
        keypath: 'title',
        operator: '=',
        value: '',
      },
    },
  },
  {
    label: 'Pinned notes',
    description: 'Matches notes that are pinned.',
    predicate: {
      keypath: 'pinned',
      operator: '=',
      value: true,
    },
  },
  {
    label: 'Starred notes',
    description: 'Matches notes that are starred.',
    predicate: {
      keypath: 'starred',
      operator: '=',
      value: true,
    },
  },
  {
    label: 'Modified in the last 7 days',
    description: 'Matches notes you have edited within the past week.',
    predicate: {
      keypath: 'userModifiedDate',
      operator: '>',
      value: '7.days.ago',
    },
  },
  {
    label: `Notes with topic "${exampleTagTitle}"`,
    description: 'Matches notes that have the given topic. Replace the value with your own topic name.',
    predicate: {
      keypath: 'tags',
      operator: 'includes',
      value: {
        keypath: 'title',
        operator: '=',
        value: exampleTagTitle,
      },
    },
  },
  {
    label: `Untrashed notes containing "${exampleTagTitle}"`,
    description: 'Matches notes that are not in the trash and whose text contains the given word.',
    predicate: {
      operator: 'and',
      value: [
        {
          keypath: 'trashed',
          operator: '=',
          value: false,
        },
        {
          keypath: 'text',
          operator: 'includes',
          value: exampleTagTitle,
        },
      ],
    },
  },
  {
    label: 'Long notes (over 1000 characters)',
    description: 'Matches notes whose text is longer than 1000 characters.',
    predicate: {
      keypath: 'text.length',
      operator: '>',
      value: 1000,
    },
  },
  {
    label: 'Protected notes',
    description: 'Matches notes that are protected.',
    predicate: {
      keypath: 'protected',
      operator: '=',
      value: true,
    },
  },
]

export const presetToJsonString = (preset: PredicatePreset): string => JSON.stringify(preset.predicate, null, 2)

export type PredicateValidationResult = {
  isValid: boolean
  /** A user-facing explanation of why the predicate is invalid, when applicable. */
  error?: string
}

/**
 * Validate a raw JSON string the user typed into the custom predicate field.
 * Reuses the real `predicateFromJson` parser so that what passes here is exactly
 * what the smart view will later accept. Returns a friendly error message that
 * can be shown inline.
 */
export const validatePredicateJsonString = (rawJson: string | undefined): PredicateValidationResult => {
  if (!rawJson || rawJson.trim().length === 0) {
    return { isValid: false, error: 'Enter a predicate to define which notes this smart view should match.' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson)
  } catch (error) {
    return {
      isValid: false,
      error: 'This is not valid JSON. Check for missing quotes, commas, or braces.',
    }
  }

  if (Array.isArray(parsed)) {
    return {
      isValid: false,
      error: 'A predicate must be a JSON object with "keypath", "operator", and "value" fields, not an array.',
    }
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return {
      isValid: false,
      error: 'A predicate must be a JSON object with "operator" and "value" fields.',
    }
  }

  if (!('operator' in parsed)) {
    return {
      isValid: false,
      error: 'The predicate is missing an "operator" field (for example "=", "includes", "and", or "not").',
    }
  }

  try {
    const predicate = predicateFromJson(parsed as PredicateJsonForm)
    if (!predicate) {
      return { isValid: false, error: 'This predicate could not be parsed. Double check the fields and try again.' }
    }
    return { isValid: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return {
      isValid: false,
      error: `This predicate could not be parsed: ${message}`,
    }
  }
}
