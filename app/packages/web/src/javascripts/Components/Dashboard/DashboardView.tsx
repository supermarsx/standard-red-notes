import { forwardRef, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { ApplicationEvent, ContentType, SNNote, VectorIconNameOrEmoji } from '@standardnotes/snjs'
import { classNames } from '@standardnotes/utils'
import { WebApplication } from '@/Application/WebApplication'
import Icon from '@/Components/Icon/Icon'
import { useResponsiveAppPane } from '../Panes/ResponsivePaneProvider'
import { AppPaneId } from '../Panes/AppPaneMetadata'
import { formatDateForContextMenu } from '@/Utils/DateUtils'
import {
  AccountStatistics,
  computeAccountStatistics,
  deriveLastLoginFromSessions,
} from './Statistics'

type Props = {
  application: WebApplication
  className?: string
  id: string
  children?: ReactNode
}

const RECOMPUTE_THROTTLE_MS = 1500

/** Human-readable "x days/months/years" age from an epoch ms anchor. */
function formatAccountAge(firstItemCreated?: number): string {
  if (!firstItemCreated) {
    return '—'
  }
  const days = Math.max(0, Math.floor((Date.now() - firstItemCreated) / (1000 * 60 * 60 * 24)))
  if (days < 1) {
    return 'Today'
  }
  if (days < 30) {
    return `${days} day${days === 1 ? '' : 's'}`
  }
  if (days < 365) {
    const months = Math.floor(days / 30)
    return `${months} month${months === 1 ? '' : 's'}`
  }
  const years = Math.floor(days / 365)
  const remMonths = Math.floor((days - years * 365) / 30)
  return remMonths > 0 ? `${years}y ${remMonths}m` : `${years} year${years === 1 ? '' : 's'}`
}

function formatDate(epochMs?: number): string {
  if (!epochMs) {
    return '—'
  }
  return formatDateForContextMenu(new Date(epochMs)) ?? '—'
}

type StatCardProps = {
  icon: VectorIconNameOrEmoji
  label: string
  value: string | number
  hint?: string
}

const StatCard = ({ icon, label, value, hint }: StatCardProps) => (
  <div className="flex flex-col rounded-md border border-border bg-default p-4 shadow-sm">
    <div className="flex items-center gap-2 text-neutral">
      <Icon type={icon} className="flex-shrink-0 text-info" size="medium" />
      <span className="text-xs font-semibold uppercase tracking-wide">{label}</span>
    </div>
    <div className="mt-2 break-words text-2xl font-bold text-text">{value}</div>
    {hint && <div className="mt-1 text-xs text-passive-1">{hint}</div>}
  </div>
)

const DashboardView = forwardRef<HTMLDivElement, Props>(({ application, className, id, children }, ref) => {
  const { presentPane, removePane } = useResponsiveAppPane()

  // The last-login value comes from a SINGLE sessions fetch, cached for the life
  // of this pane. We never poll it.
  const [lastLogin, setLastLogin] = useState<number | undefined>(undefined)
  const lastLoginRef = useRef<number | undefined>(undefined)
  lastLoginRef.current = lastLogin

  const [stats, setStats] = useState<AccountStatistics>(() =>
    computeAccountStatistics(application, { lastLogin: undefined }),
  )

  const isSignedIn = application.sessions.getUser() !== undefined

  // --- one-shot sessions fetch (cached) ----------------------------------
  useEffect(() => {
    let cancelled = false
    if (!isSignedIn) {
      return
    }
    void (async () => {
      try {
        const response = await application.getSessions()
        if (cancelled) {
          return
        }
        const data = (response as { data?: unknown }).data
        if (Array.isArray(data)) {
          const derived = deriveLastLoginFromSessions(data)
          setLastLogin(derived)
        }
      } catch (error) {
        console.error('Failed to load sessions for dashboard', error)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [application, isSignedIn])

  // --- throttled recompute from local item state -------------------------
  // We recompute at most once per RECOMPUTE_THROTTLE_MS, driven by item streams
  // and sync completion. No server polling — purely derived from synced state.
  useEffect(() => {
    let throttleTimeout: ReturnType<typeof setTimeout> | undefined
    let pending = false

    const recompute = () => {
      pending = false
      setStats(computeAccountStatistics(application, { lastLogin: lastLoginRef.current }))
    }

    const scheduleRecompute = () => {
      if (throttleTimeout) {
        pending = true
        return
      }
      recompute()
      throttleTimeout = setTimeout(() => {
        throttleTimeout = undefined
        if (pending) {
          recompute()
        }
      }, RECOMPUTE_THROTTLE_MS)
    }

    const removeItemObserver = application.items.streamItems(
      [ContentType.TYPES.Note, ContentType.TYPES.Tag, ContentType.TYPES.File],
      () => scheduleRecompute(),
    )

    const removeSyncObserver = application.addEventObserver(async () => {
      scheduleRecompute()
    }, ApplicationEvent.CompletedFullSync)

    return () => {
      removeItemObserver()
      removeSyncObserver()
      if (throttleTimeout) {
        clearTimeout(throttleTimeout)
      }
    }
  }, [application])

  // Re-derive once the cached login lands, without re-running the heavy counts.
  useEffect(() => {
    setStats((previous) => ({ ...previous, lastLogin }))
  }, [lastLogin])

  const openNote = useCallback(
    (uuid: string) => {
      const note = application.items.findItem<SNNote>(uuid)
      if (!note) {
        return
      }
      application.itemListController.keepActiveItemOpenForSystemView(note.uuid)
      void application.itemListController.selectItemUsingInstance(note, true)
      presentPane(AppPaneId.Editor)
    },
    [application, presentPane],
  )

  const countCards: StatCardProps[] = useMemo(
    () => [
      { icon: 'notes', label: 'Notes', value: stats.noteCount },
      { icon: 'hashtag', label: 'Topics', value: stats.tagCount },
      { icon: 'file', label: 'Files', value: stats.fileCount },
      { icon: 'pin', label: 'Pinned', value: stats.pinnedCount },
      { icon: 'archive', label: 'Archived', value: stats.archivedCount },
      { icon: 'trash', label: 'Trashed', value: stats.trashedCount },
      {
        icon: 'pencil',
        label: 'Notes edited',
        value: stats.editedNoteCount,
        hint: 'Notes changed since creation',
      },
      {
        icon: 'text',
        label: 'Total words',
        value: stats.totalWords.toLocaleString(),
        hint: 'Approx, across notes',
      },
    ],
    [stats],
  )

  const activityCards: StatCardProps[] = useMemo(
    () => [
      { icon: 'clock', label: 'Last change', value: formatDate(stats.lastChange) },
      {
        icon: 'user',
        label: 'Last login',
        value: isSignedIn ? formatDate(stats.lastLogin) : 'Offline',
      },
      { icon: 'info', label: 'Account age', value: formatAccountAge(stats.firstItemCreated) },
    ],
    [stats, isSignedIn],
  )

  return (
    <div
      id={id}
      ref={ref}
      className={classNames(className, 'flex h-full flex-col overflow-hidden border-l border-border bg-default')}
    >
      <div className="flex items-center justify-between border-b border-border bg-contrast px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon type="dashboard" className="flex-shrink-0 text-info" />
          <span className="text-base font-bold">Dashboard</span>
        </div>
        <button
          className="rounded p-1 hover:bg-default"
          onClick={() => removePane(AppPaneId.Dashboard)}
          aria-label="Close dashboard"
          title="Close"
        >
          <Icon type="menu-close" />
        </button>
      </div>

      <div className="flex-grow overflow-y-auto p-4">
        <section aria-label="Account counts">
          <h2 className="mb-2 text-sm font-bold text-text">Library</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {countCards.map((card) => (
              <StatCard key={card.label} {...card} />
            ))}
          </div>
        </section>

        <section aria-label="Account activity" className="mt-6">
          <h2 className="mb-2 text-sm font-bold text-text">Activity</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {activityCards.map((card) => (
              <StatCard key={card.label} {...card} />
            ))}
          </div>
        </section>

        <section aria-label="Recently edited notes" className="mt-6">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-bold text-text">
            <Icon type="history" className="text-neutral" size="small" />
            Recent activity
          </h2>
          <div className="overflow-hidden rounded-md border border-border bg-default">
            {stats.recentNotes.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-passive-1">No recently edited notes yet.</div>
            ) : (
              <ul>
                {stats.recentNotes.map((note) => (
                  <li key={note.uuid} className="border-b border-border last:border-b-0">
                    <button
                      className="flex w-full flex-col items-start gap-0.5 px-4 py-3 text-left hover:bg-contrast"
                      onClick={() => openNote(note.uuid)}
                    >
                      <div className="flex w-full items-center justify-between gap-2">
                        <span className="truncate text-sm font-semibold text-text">{note.title}</span>
                        <span className="flex-shrink-0 text-xs text-passive-1">{formatDate(note.modified)}</span>
                      </div>
                      {note.preview && <span className="line-clamp-1 text-xs text-neutral">{note.preview}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
      {children}
    </div>
  )
})

DashboardView.displayName = 'DashboardView'

export default observer(DashboardView)
