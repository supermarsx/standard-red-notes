import { WebService, WebValidationError } from './WebService'

export interface InternetResearchInput {
  capability: 'repository' | 'academic'
  provider: 'github' | 'gitlab' | 'crossref'
  action:
    | 'metadata'
    | 'tree'
    | 'file'
    | 'issues'
    | 'issue'
    | 'pulls'
    | 'pull'
    | 'comments'
    | 'pull-comments'
    | 'pull-files'
    | 'releases'
    | 'release'
    | 'search'
    | 'work'
  repository?: string
  path?: string
  ref?: string
  number?: number
  query?: string
  doi?: string
  tag?: string
  page?: number
  limit?: number
}

export interface InternetResearchResult {
  provider: string
  action: string
  url: string
  data: unknown
  page?: number
  /** A full page may have a successor; this is not an exhaustive-results claim. */
  hasMore?: boolean
  truncated?: boolean
  rateLimited?: true
  error?: string
}

function text(value: unknown, name: string, max = 300): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new WebValidationError(`Invalid ${name}.`)
  }
  return value.trim()
}
function integer(value: unknown, fallback: number, max: number): number {
  if (value === undefined) {
    return fallback
  }
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) {
    throw new WebValidationError(`Expected an integer between 1 and ${max}.`)
  }
  return value as number
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}
// Keep API payloads compact and predictable; never forward arbitrary upstream fields.
const fields = new Set([
  'id',
  'iid',
  'number',
  'name',
  'full_name',
  'path',
  'path_with_namespace',
  'description',
  'body',
  'title',
  'html_url',
  'web_url',
  'url',
  'state',
  'sha',
  'type',
  'size',
  'default_branch',
  'language',
  'stargazers_count',
  'star_count',
  'forks_count',
  'open_issues_count',
  'created_at',
  'updated_at',
  'published_at',
  'released_at',
  'tag_name',
  'prerelease',
  'draft',
  'merged',
  'merged_at',
  'mergeable',
  'source_branch',
  'target_branch',
  'encoding',
  'login',
  'username',
  'user',
  'author',
  'head',
  'base',
  'ref',
  'assets',
  'links',
  'browser_download_url',
  'DOI',
  'URL',
  'abstract',
  'container-title',
  'publisher',
  'published',
  'date-parts',
  'given',
  'family',
  'is-referenced-by-count',
  'license',
  'link',
  'content-type',
  'content-version',
  'filename',
  'status',
  'additions',
  'deletions',
  'changes',
  'patch',
  'old_path',
  'new_path',
  'diff',
  'new_file',
  'deleted_file',
  'renamed_file',
])
function compact(value: unknown, markTruncated: () => void, depth = 0): unknown {
  if (depth > 5) {
    markTruncated()
    return undefined
  }
  if (typeof value === 'string') {
    if (value.length > 12_000) {
      markTruncated()
    }
    return value.slice(0, 12_000)
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value
  }
  if (Array.isArray(value)) {
    if (value.length > 20) {
      markTruncated()
    }
    return value.slice(0, 20).map((entry) => compact(entry, markTruncated, depth + 1))
  }
  return Object.fromEntries(
    Object.entries(record(value))
      .filter(([key]) => fields.has(key))
      .map(([key, entry]) => [key, compact(entry, markTruncated, depth + 1)]),
  )
}

/** Public native APIs only. All reads retain WebService DNS, redirect, byte and time guards. */
export class InternetResearchService {
  constructor(private readonly web: Pick<WebService, 'fetch'>) {}

  async execute(input: InternetResearchInput): Promise<InternetResearchResult> {
    if (!input || !['repository', 'academic'].includes(input.capability)) {
      throw new WebValidationError('Invalid capability.')
    }
    const page = integer(input.page, 1, 100)
    const limit = integer(input.limit, 10, 20)
    const academic = input.capability === 'academic'
    if (academic ? input.provider !== 'crossref' : !['github', 'gitlab'].includes(input.provider)) {
      throw new WebValidationError('Invalid provider for capability.')
    }
    let url: URL
    if (academic) {
      if (input.action === 'search') {
        url = new URL('https://api.crossref.org/works')
        url.searchParams.set('query', text(input.query, 'query', 500))
        url.searchParams.set('rows', String(limit))
        url.searchParams.set('offset', String((page - 1) * limit))
        url.searchParams.set(
          'select',
          'DOI,title,author,container-title,publisher,published,is-referenced-by-count,URL,abstract,link,license,type',
        )
      } else if (input.action === 'work') {
        const doi = text(input.doi, 'DOI', 250)
        if (!/^10\.\d{4,9}\/\S+$/i.test(doi)) {
          throw new WebValidationError('Invalid DOI.')
        }
        url = new URL(`https://api.crossref.org/works/${encodeURIComponent(doi)}`)
      } else {
        throw new WebValidationError('Academic action must be search or work.')
      }
    } else if (input.action === 'search') {
      url = new URL(
        input.provider === 'github'
          ? 'https://api.github.com/search/repositories'
          : 'https://gitlab.com/api/v4/projects',
      )
      url.searchParams.set(input.provider === 'github' ? 'q' : 'search', text(input.query, 'query', 500))
    } else {
      const repo = text(input.repository, 'repository')
      const parts = repo.split('/')
      if (
        parts.length < 2 ||
        (input.provider === 'github' && parts.length !== 2) ||
        parts.some((p) => !/^[\w.-]+$/.test(p) || p === '.' || p === '..')
      ) {
        throw new WebValidationError('Use a repository path such as owner/project, without a URL.')
      }
      const github = input.provider === 'github'
      if (github && input.action === 'tree' && page !== 1) {
        throw new WebValidationError(
          'GitHub directory listings do not support pagination. Read a specific subdirectory path.',
        )
      }
      const base = github
        ? `https://api.github.com/repos/${parts.map(encodeURIComponent).join('/')}`
        : `https://gitlab.com/api/v4/projects/${encodeURIComponent(repo)}`
      const number = (): number =>
        integer(input.number, 0, 2_147_483_647) ||
        (() => {
          throw new WebValidationError('Issue or pull request number is required.')
        })()
      let suffix: string
      switch (input.action) {
        case 'metadata':
          suffix = ''
          break
        case 'tree':
        case 'file': {
          const path = input.path === undefined && input.action === 'tree' ? '' : text(input.path, 'path', 1000)
          if (path.startsWith('/') || path.split('/').some((p) => p === '..' || p === '.') || path.includes('\\')) {
            throw new WebValidationError('Invalid repository path.')
          }
          suffix = github
            ? `/contents/${path.split('/').map(encodeURIComponent).join('/')}`
            : input.action === 'tree'
              ? '/repository/tree'
              : `/repository/files/${encodeURIComponent(path)}`
          url = new URL(base + suffix)
          if (!github && input.action === 'tree' && path) {
            url.searchParams.set('path', path)
          }
          if (input.ref !== undefined) {
            url.searchParams.set('ref', text(input.ref, 'ref', 200))
          } else if (!github && input.action === 'file') {
            url.searchParams.set('ref', 'HEAD')
          }
          break
        }
        case 'issues':
          suffix = '/issues'
          break
        case 'issue':
          suffix = `/issues/${number()}`
          break
        case 'pulls':
          suffix = github ? '/pulls' : '/merge_requests'
          break
        case 'pull':
          suffix = `${github ? '/pulls' : '/merge_requests'}/${number()}`
          break
        case 'comments':
          suffix = `/issues/${number()}/${github ? 'comments' : 'notes'}`
          break
        case 'pull-comments':
          suffix = github ? `/issues/${number()}/comments` : `/merge_requests/${number()}/notes`
          break
        case 'pull-files':
          suffix = github ? `/pulls/${number()}/files` : `/merge_requests/${number()}/diffs`
          break
        case 'releases':
          suffix = '/releases'
          break
        case 'release':
          suffix = `${github ? '/releases/tags' : '/releases'}/${encodeURIComponent(text(input.tag, 'tag', 200))}`
          break
        default:
          throw new WebValidationError('Invalid repository action.')
      }
      url ??= new URL(base + suffix)
    }
    if (!academic) {
      url.searchParams.set('per_page', String(limit))
      url.searchParams.set('page', String(page))
    }
    const result: InternetResearchResult = { provider: input.provider, action: input.action, url: url.href, data: null }
    const response = await this.web.fetch(url.href)
    if (response.status === 429 || (response.status === 403 && /rate.?limit/i.test(response.text))) {
      return { ...result, rateLimited: true, error: 'The public API rate limit was reached. Try again later.' }
    }
    if (response.status < 200 || response.status >= 300) {
      return { ...result, error: `Public API returned HTTP ${response.status}.` }
    }
    let payload: unknown
    try {
      payload = JSON.parse(response.text)
    } catch {
      return {
        ...result,
        error: 'Public API response was invalid or exceeded the readable response limit. Request a smaller page.',
      }
    }
    if (academic) {
      payload = record(payload).message
    }
    if (input.action === 'search') {
      payload = record(payload).items ?? payload
    }
    const markTruncated = () => {
      result.truncated = true
    }
    if (input.action === 'file') {
      const file = record(payload)
      if (file.encoding !== 'base64' || typeof file.content !== 'string' || file.content.length > 88_000) {
        return { ...result, error: 'This file is not available as bounded inline text. Use a smaller text file.' }
      }
      const decoded = Buffer.from(file.content, 'base64')
      if (decoded.length > 64_000 || decoded.includes(0)) {
        return { ...result, error: 'File is binary or larger than the 64 KB text limit.' }
      }
      result.data = { ...record(compact(file, markTruncated)), content: decoded.toString('utf8') }
    } else {
      if (Array.isArray(payload)) {
        result.page = page
        result.hasMore = payload.length >= limit
        if (input.provider === 'github' && input.action === 'tree') {
          result.hasMore = false
          result.truncated = payload.length > limit
        }
        payload = payload.slice(0, limit)
      }
      result.data = compact(payload, markTruncated)
    }
    return result
  }
}
