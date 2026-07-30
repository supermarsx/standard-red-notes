const ParsingBaseUrl = 'http://request.invalid'
const UnavailableRequestUrl = '[unavailable-request-url]'
const UnparseableRequestUrl = '[unparseable-request-url]'

/**
 * Keeps request diagnostics useful without persisting credentials or private
 * parameters carried in a URL. Only the parsed pathname and the number of
 * query parameters are retained; origins, userinfo, query names/values, and
 * fragments are discarded.
 */
export function sanitizeRequestUrlForLogging(rawUrl: unknown): string {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    return UnavailableRequestUrl
  }

  try {
    const parsedUrl = new URL(rawUrl, ParsingBaseUrl)
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return UnparseableRequestUrl
    }

    let queryParameterCount = 0
    parsedUrl.searchParams.forEach(() => {
      queryParameterCount += 1
    })

    const pathname = parsedUrl.pathname || '/'
    return queryParameterCount > 0 ? `${pathname} [query-parameter-count=${queryParameterCount}]` : pathname
  } catch {
    return UnparseableRequestUrl
  }
}
