import { confirmDialog } from '@standardnotes/ui-services'
import type { WebApplication } from '@/Application/WebApplication'
import { webFetch, webSearch } from './webTools'
import { AssistantActionNotAllowedError } from './AssistantActionNotAllowedError'

export interface ResearchWebSource {
  title: string
  url: string
  text: string
}

export interface ResearchWebEvidence {
  sources: ResearchWebSource[]
  status: 'retrieved' | 'unavailable' | 'declined' | 'no-results'
}

export interface ResearchWebOptions {
  signal?: AbortSignal
  isCurrent: () => boolean
  requestConfirmation?: (action: 'search' | 'fetch', value: string) => Promise<boolean>
}

const requestWebConfirmation: NonNullable<ResearchWebOptions['requestConfirmation']> = (action, value) =>
  confirmDialog({
    title: action === 'search' ? 'Search the web for this research?' : 'Read this web page?',
    text:
      `${action === 'search' ? 'Search query' : 'Page URL'}: ${value}\n\n` +
      'This is sent outside end-to-end encryption to your server and its configured web service. ' +
      'Retrieved text is sent to your configured AI provider. No note content is included in the search query.',
    confirmButtonText: action === 'search' ? 'Search' : 'Read page',
  })

/** One approved topic query and at most three approved pages; never direct browser networking. */
export async function gatherResearchWebEvidence(
  application: WebApplication,
  topic: string,
  options: ResearchWebOptions,
): Promise<ResearchWebEvidence> {
  const current = () => !options.signal?.aborted && options.isCurrent()
  const check = () => {
    if (!current()) {
      throw new Error('Research stopped because it was cancelled or the active account changed.')
    }
  }
  const confirm = options.requestConfirmation ?? requestWebConfirmation
  const approve = async (action: 'search' | 'fetch', value: string) => {
    check()
    const result = await confirm(action, value)
    check()
    if (!result) {
      throw new AssistantActionNotAllowedError(
        `The web ${action === 'search' ? 'search' : 'page read'} was not allowed. Research stopped.`,
      )
    }
    return result
  }
  const query = topic.trim()
  if (!query) {
    return { sources: [], status: 'no-results' }
  }
  if (!(await approve('search', query))) {
    return { sources: [], status: 'declined' }
  }
  const search = await webSearch(application, query, { limit: 3, signal: options.signal })
  check()
  if ('error' in search) {
    if (search.cancelled) {
      throw new AssistantActionNotAllowedError(search.message ?? search.error)
    }
    return { sources: [], status: 'unavailable' }
  }
  const sources: ResearchWebSource[] = []
  let failed = false
  let declined = false
  const seen = new Set<string>()
  for (const result of search.results.slice(0, 3)) {
    if (seen.has(result.url)) {
      continue
    }
    seen.add(result.url)
    if (!(await approve('fetch', result.url))) {
      declined = true
      continue
    }
    const page = await webFetch(application, result.url, { signal: options.signal })
    check()
    if ('error' in page && page.cancelled) {
      throw new AssistantActionNotAllowedError(page.message ?? page.error)
    }
    if ('error' in page || !page.text.trim()) {
      failed = true
      continue
    }
    sources.push({
      title: (page.title || result.title).slice(0, 500),
      url: result.url,
      text: page.text.slice(0, 12000),
    })
  }
  return {
    sources,
    status: sources.length ? 'retrieved' : failed ? 'unavailable' : declined ? 'declined' : 'no-results',
  }
}

/** JSON quoting prevents fetched content from breaking out of the evidence structure. */
export function renderResearchWebEvidence(evidence: ResearchWebEvidence): string {
  return JSON.stringify({ status: evidence.status, sources: evidence.sources })
}

export function researchWebSourcesMarkdown(evidence: ResearchWebEvidence): string {
  if (!evidence.sources.length) {
    return `> Live web research: ${evidence.status}. No web pages were retrieved; this report is not based on live web evidence.`
  }
  const sources = evidence.sources.map((source, index) => {
    const title = source.title.replace(/[[\]\\<>\r\n]/g, ' ').trim() || 'Web page'
    const url = source.url.replace(/</g, '%3C').replace(/>/g, '%3E')
    return `- [W${index + 1}] [${title}](<${url}>)`
  })
  return `## Retrieved web sources\n\n${sources.join('\n')}\n\n> These pages were retrieved during this run. Their contents and the AI report may be incomplete or inaccurate; verify important claims against the linked sources.`
}
