import { FunctionComponent, useEffect, useMemo, useState } from 'react'
import { VectorIconNameOrEmoji } from '@standardnotes/snjs'
import { achievements, METRICS } from '@/Achievements'
import { classNames } from '@standardnotes/utils'
import Icon from '@/Components/Icon/Icon'
import {
  DocBlock,
  DocCategory,
  DocPage,
  DOC_CATEGORIES,
  getPage,
  searchDocs,
} from './content'

const CALLOUT_STYLES: Record<'info' | 'tip' | 'warning', { border: string; icon: VectorIconNameOrEmoji; iconColor: string }> = {
  info: { border: 'border-info', icon: 'details-block', iconColor: 'text-info' },
  tip: { border: 'border-info', icon: 'star-filled', iconColor: 'text-success' },
  warning: { border: 'border-danger', icon: 'clear-circle-filled', iconColor: 'text-warning' },
}

const BlockView: FunctionComponent<{ block: DocBlock; onNavigate: (id: string) => void }> = ({ block }) => {
  switch (block.type) {
    case 'heading':
      return <h3 className="mb-1 mt-5 text-base font-bold text-text lg:text-sm">{block.text}</h3>
    case 'paragraph':
      return <p className="my-2 text-base leading-relaxed text-foreground lg:text-sm">{block.text}</p>
    case 'list':
      return (
        <ul className="my-2 list-disc space-y-1 pl-5 text-base text-foreground lg:text-sm">
          {block.items.map((item, index) => (
            <li key={index} className="leading-relaxed">
              {item}
            </li>
          ))}
        </ul>
      )
    case 'steps':
      return (
        <ol className="my-2 list-decimal space-y-1 pl-5 text-base text-foreground lg:text-sm">
          {block.items.map((item, index) => (
            <li key={index} className="leading-relaxed">
              {item}
            </li>
          ))}
        </ol>
      )
    case 'code':
      return (
        <pre className="my-3 overflow-x-auto rounded bg-contrast p-3 text-xs text-text">
          <code>{block.code}</code>
        </pre>
      )
    case 'table':
      return (
        <div className="my-3 overflow-hidden rounded border border-border">
          <table className="w-full border-collapse text-left text-sm">
            <tbody>
              {block.rows.map((row, index) => (
                <tr key={index} className="border-b border-border last:border-b-0">
                  <th className="w-1/3 bg-contrast px-3 py-2 align-top font-semibold text-text">{row[0]}</th>
                  <td className="px-3 py-2 align-top text-foreground">{row[1]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'callout': {
      const style = CALLOUT_STYLES[block.variant]
      return (
        <div className={classNames('my-3 flex gap-2 rounded border-l-2 bg-contrast px-3 py-2', style.border)}>
          <Icon type={style.icon} className={classNames('mt-0.5 flex-shrink-0', style.iconColor)} size="small" />
          <p className="text-sm leading-relaxed text-foreground">{block.text}</p>
        </div>
      )
    }
  }
}

const RelatedLinks: FunctionComponent<{ ids: string[]; onNavigate: (id: string) => void }> = ({ ids, onNavigate }) => {
  const pages = ids.map((id) => getPage(id)).filter((entry): entry is { page: DocPage; category: DocCategory } => !!entry)
  if (pages.length === 0) {
    return null
  }
  return (
    <div className="mt-6 border-t border-border pt-4">
      <div className="mb-2 text-sm font-semibold text-neutral">Related</div>
      <div className="flex flex-wrap gap-2">
        {pages.map(({ page }) => (
          <button
            key={page.id}
            onClick={() => onNavigate(page.id)}
            className="flex items-center gap-1 rounded border border-border bg-default px-2.5 py-1 text-sm text-text hover:bg-contrast focus:bg-contrast"
          >
            <Icon type="open-in" size="small" className="text-neutral" />
            {page.title}
          </button>
        ))}
      </div>
    </div>
  )
}

const PageView: FunctionComponent<{ pageId: string; onNavigate: (id: string | null) => void }> = ({
  pageId,
  onNavigate,
}) => {
  const entry = getPage(pageId)
  if (!entry) {
    return <p className="text-foreground">That page could not be found.</p>
  }
  const { page, category } = entry
  return (
    <article className="mx-auto max-w-3xl">
      <nav className="mb-3 flex flex-wrap items-center gap-1 text-sm text-neutral">
        <button onClick={() => onNavigate(null)} className="hover:text-info hover:underline">
          Documentation
        </button>
        <Icon type="chevron-right" size="small" />
        <span>{category.title}</span>
        <Icon type="chevron-right" size="small" />
        <span className="text-text">{page.title}</span>
      </nav>
      <h2 className="m-0 mb-1 text-2xl font-bold text-text">{page.title}</h2>
      <p className="mb-4 text-base text-neutral lg:text-sm">{page.summary}</p>
      {page.blocks.map((block, index) => (
        <BlockView key={index} block={block} onNavigate={(id) => onNavigate(id)} />
      ))}
      {page.related && page.related.length > 0 && (
        <RelatedLinks ids={page.related} onNavigate={(id) => onNavigate(id)} />
      )}
    </article>
  )
}

const HomeView: FunctionComponent<{ onNavigate: (id: string) => void }> = ({ onNavigate }) => (
  <div className="mx-auto max-w-3xl">
    <h2 className="m-0 mb-1 text-2xl font-bold text-text">Documentation</h2>
    <p className="mb-5 text-base text-neutral lg:text-sm">
      Everything you need to use Standard Red Notes — privacy, editors, sync, backups, self-hosting, and more. Pick a
      topic below or search.
    </p>
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {DOC_CATEGORIES.map((category) => (
        <div key={category.id} className="rounded-md border border-border bg-default p-3">
          <div className="mb-1.5 flex items-center gap-2">
            <Icon type={category.icon as VectorIconNameOrEmoji} className="text-info" />
            <h3 className="m-0 text-base font-bold text-text">{category.title}</h3>
          </div>
          <p className="mb-2 text-sm text-neutral">{category.description}</p>
          <ul className="space-y-0.5">
            {category.pages.map((page) => (
              <li key={page.id}>
                <button
                  onClick={() => onNavigate(page.id)}
                  className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-sm text-info hover:bg-contrast hover:underline"
                >
                  <Icon type="caret-right" size="small" className="flex-shrink-0 text-neutral" />
                  {page.title}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  </div>
)

const SearchResultsView: FunctionComponent<{ query: string; onNavigate: (id: string) => void }> = ({
  query,
  onNavigate,
}) => {
  const results = useMemo(() => searchDocs(query), [query])
  return (
    <div className="mx-auto max-w-3xl">
      <h2 className="m-0 mb-3 text-lg font-bold text-text">
        {results.length} {results.length === 1 ? 'result' : 'results'} for “{query}”
      </h2>
      {results.length === 0 ? (
        <p className="text-foreground">No matching articles. Try a different term.</p>
      ) : (
        <ul className="space-y-2">
          {results.map(({ page, category }) => (
            <li key={page.id}>
              <button
                onClick={() => onNavigate(page.id)}
                className="w-full rounded-md border border-border bg-default p-3 text-left hover:bg-contrast"
              >
                <div className="mb-0.5 flex items-center gap-2 text-xs text-neutral">
                  <Icon type={category.icon as VectorIconNameOrEmoji} size="small" />
                  {category.title}
                </div>
                <div className="font-semibold text-text">{page.title}</div>
                <div className="text-sm text-neutral">{page.summary}</div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const Documentation: FunctionComponent = () => {
  const [activeId, setActiveId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const trimmedQuery = query.trim()

  // Achievements: count opening the documentation, and accumulate time spent
  // (in hours) across the open→close lifetime. Web-local, fire-and-forget.
  useEffect(() => {
    achievements.markEvent(METRICS.documentationOpened)
    const openedAt = Date.now()
    return () => {
      const hours = (Date.now() - openedAt) / (1000 * 60 * 60)
      if (hours > 0) {
        achievements.increment(METRICS.documentationHoursSpent, hours)
      }
    }
  }, [])

  const navigate = (id: string | null) => {
    setActiveId(id)
    setQuery('')
  }

  return (
    <div className="flex h-full min-h-0 flex-grow flex-col overflow-hidden md:flex-row">
      <nav className="flex max-h-48 flex-shrink-0 flex-col overflow-y-auto border-b border-border p-3 md:h-full md:max-h-none md:min-h-0 md:w-60 md:border-b-0 md:border-r">
        <div className="relative mb-3">
          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-neutral">
            <Icon type="select-all" size="small" />
          </span>
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search documentation"
            aria-label="Search documentation"
            className="w-full rounded border border-border bg-default py-1.5 pl-8 pr-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-info"
          />
        </div>
        <button
          onClick={() => navigate(null)}
          className={classNames(
            'mb-2 flex items-center gap-2 rounded px-2 py-1 text-left text-sm font-semibold hover:bg-contrast',
            activeId === null && !trimmedQuery ? 'bg-contrast text-info' : 'text-text',
          )}
        >
          <Icon type="notes-filled" size="small" />
          Overview
        </button>
        {DOC_CATEGORIES.map((category) => (
          <div key={category.id} className="mb-2">
            <div className="flex items-center gap-2 px-2 py-1 text-xs font-bold uppercase tracking-wide text-neutral">
              <Icon type={category.icon as VectorIconNameOrEmoji} size="small" />
              {category.title}
            </div>
            <ul>
              {category.pages.map((page) => (
                <li key={page.id}>
                  <button
                    onClick={() => navigate(page.id)}
                    className={classNames(
                      'block w-full truncate rounded px-2 py-1 pl-7 text-left text-sm hover:bg-contrast',
                      activeId === page.id && !trimmedQuery ? 'bg-contrast font-medium text-info' : 'text-foreground',
                    )}
                    title={page.title}
                  >
                    {page.title}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className="min-h-0 flex-grow overflow-y-auto px-4 py-5 text-foreground md:h-full md:px-8">
        {trimmedQuery ? (
          <SearchResultsView query={trimmedQuery} onNavigate={navigate} />
        ) : activeId ? (
          <PageView pageId={activeId} onNavigate={navigate} />
        ) : (
          <HomeView onNavigate={navigate} />
        )}
      </div>
    </div>
  )
}

export default Documentation
