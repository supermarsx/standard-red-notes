// A small, curated list of common target languages for the Translate selection
// action. This is only a convenience picker — the underlying action accepts ANY
// free-text language (the model is asked to translate into whatever the user
// typed), so the list does not need to be exhaustive. Kept deliberately short
// and dependency-free.

export const COMMON_LANGUAGES: string[] = [
  'Arabic',
  'Bengali',
  'Chinese (Simplified)',
  'Chinese (Traditional)',
  'Czech',
  'Danish',
  'Dutch',
  'English',
  'Finnish',
  'French',
  'German',
  'Greek',
  'Hebrew',
  'Hindi',
  'Hungarian',
  'Indonesian',
  'Italian',
  'Japanese',
  'Korean',
  'Norwegian',
  'Polish',
  'Portuguese',
  'Portuguese (Brazil)',
  'Romanian',
  'Russian',
  'Spanish',
  'Swedish',
  'Thai',
  'Turkish',
  'Ukrainian',
  'Vietnamese',
]

/**
 * Case-insensitive substring filter over the common-language list. An empty
 * query returns the full list. Pure — used to drive the searchable picker.
 */
export function filterLanguages(query: string): string[] {
  const q = query.trim().toLowerCase()
  if (!q) {
    return COMMON_LANGUAGES
  }
  return COMMON_LANGUAGES.filter((language) => language.toLowerCase().includes(q))
}
