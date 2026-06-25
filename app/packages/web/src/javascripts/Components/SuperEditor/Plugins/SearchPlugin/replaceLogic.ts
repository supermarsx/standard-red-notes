/**
 * Pure logic for the Find & Replace feature.
 *
 * These functions are intentionally free of any Lexical/DOM dependencies so that they
 * can be unit-tested in isolation (see replaceLogic.spec.ts) and reused both by the
 * search plugin UI and the editor mutation code.
 */

export type SearchOptions = {
  isCaseSensitive: boolean
  isWholeWord: boolean
  isRegex: boolean
}

/**
 * Escapes a string so it can be used as a literal inside a RegExp.
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Builds a RegExp for the given query and options.
 *
 * - When `isRegex` is true the query is treated as a raw regular expression source.
 * - When `isRegex` is false the query is escaped and matched literally.
 * - `isWholeWord` wraps the pattern in word boundaries (`\b...\b`).
 * - `isCaseSensitive` controls the `i` flag.
 * - `global` controls the `g` flag (needed for "replace all" and for iterating matches).
 *
 * Throws a `SyntaxError` (from the RegExp constructor) when an invalid regex source is
 * provided. Callers are expected to catch this and surface an inline error.
 *
 * Returns `null` for an empty query (nothing to search for).
 */
export function buildSearchRegExp(query: string, options: SearchOptions, global = true): RegExp | null {
  if (query.length === 0) {
    return null
  }

  let source = options.isRegex ? query : escapeRegExp(query)

  if (options.isWholeWord) {
    source = `\\b(?:${source})\\b`
  }

  let flags = ''
  if (global) {
    flags += 'g'
  }
  if (!options.isCaseSensitive) {
    flags += 'i'
  }

  // The RegExp constructor throws a SyntaxError on an invalid source; let it propagate.
  return new RegExp(source, flags)
}

/**
 * Result of validating/compiling a search query.
 */
export type CompileResult =
  | { regex: RegExp | null; error: null }
  | { regex: null; error: string }

/**
 * Safely compiles a query, returning either the RegExp (or null for empty queries) or
 * an error message describing why compilation failed. Never throws.
 */
export function compileSearch(query: string, options: SearchOptions, global = true): CompileResult {
  try {
    const regex = buildSearchRegExp(query, options, global)
    return { regex, error: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid regular expression'
    return { regex: null, error: message }
  }
}

/**
 * Computes the result of replacing matches of `query` with `replacement` inside `input`.
 *
 * - When `replaceAll` is true, every match is replaced; otherwise only the first.
 * - In regex mode, replacement supports `String.prototype.replace` substitution patterns
 *   such as `$1`, `$2` (backreferences) and `$&` (whole match). In non-regex mode `$`
 *   sequences in the replacement are treated literally.
 *
 * Returns the new string along with the number of replacements made. Never throws for a
 * valid (already-compiled) input; if the query is empty the input is returned unchanged.
 */
export function computeReplacement(
  input: string,
  query: string,
  replacement: string,
  options: SearchOptions,
  replaceAll: boolean,
): { output: string; count: number } {
  if (query.length === 0) {
    return { output: input, count: 0 }
  }

  const regex = buildSearchRegExp(query, options, replaceAll)
  if (!regex) {
    return { output: input, count: 0 }
  }

  // In non-regex mode, `$` in the replacement should be literal, so escape it for
  // String.prototype.replace which interprets `$$`, `$&`, `$1`, etc.
  const safeReplacement = options.isRegex ? replacement : replacement.replace(/\$/g, '$$$$')

  let count = 0
  if (replaceAll) {
    const output = input.replace(regex, (...args) => {
      count++
      return expandReplacement(safeReplacement, args)
    })
    return { output, count }
  }

  // Single replacement: build a non-global regex so only the first match is replaced.
  const singleRegex = buildSearchRegExp(query, options, false)
  if (!singleRegex) {
    return { output: input, count: 0 }
  }
  const output = input.replace(singleRegex, (...args) => {
    count++
    return expandReplacement(safeReplacement, args)
  })
  return { output, count }
}

/**
 * Expands a `String.prototype.replace` substitution pattern given the args passed to a
 * replacer function ([match, ...groups, offset, string]). This lets us count replacements
 * while still honoring `$1`, `$&`, `$$`.
 */
function expandReplacement(replacement: string, replacerArgs: unknown[]): string {
  const match = replacerArgs[0] as string
  // Last two args are offset and full string; groups are everything in between.
  const groups = replacerArgs.slice(1, -2) as Array<string | undefined>

  return replacement.replace(/\$(\$|&|\d{1,2})/g, (_whole, token: string) => {
    if (token === '$') {
      return '$'
    }
    if (token === '&') {
      return match
    }
    const groupIndex = parseInt(token, 10)
    if (groupIndex >= 1 && groupIndex <= groups.length) {
      return groups[groupIndex - 1] ?? ''
    }
    // Unknown group reference is emitted literally (matches native behavior closely enough).
    return `$${token}`
  })
}
