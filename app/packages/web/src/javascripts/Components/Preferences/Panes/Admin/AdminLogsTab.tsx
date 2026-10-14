import { FunctionComponent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApplicationEvent, isErrorResponse } from '@standardnotes/snjs'

import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Button from '@/Components/Button/Button'
import Dropdown from '@/Components/Dropdown/Dropdown'
import DecoratedInput from '@/Components/Input/DecoratedInput'
import Spinner from '@/Components/Spinner/Spinner'
import { SkeletonList } from '@/Components/Skeleton/Skeleton'
import { LogEntry, formatLogTimestampUTC, orderLogEntries, logLevelColorClass, logMatchesText } from './adminHelpers'
import {
  LogExportFormat,
  logEntriesToJSON,
  logEntriesToText,
  logsExportFilename,
  triggerBlobDownload,
} from './adminExportUtils'

type Props = {
  application: WebApplication
  noteIfForbidden: (response: { status?: number }) => void
}

// The server clamps to 500; offer the common tail sizes.
const LIMIT_OPTIONS = [
  { label: '100 lines', value: '100' },
  { label: '200 lines', value: '200' },
  { label: '500 lines', value: '500' },
]

const LEVEL_OPTIONS = [
  { label: 'All levels', value: '' },
  { label: 'Error', value: 'error' },
  { label: 'Warn', value: 'warn' },
  { label: 'Info', value: 'info' },
  { label: 'HTTP', value: 'http' },
  { label: 'Verbose', value: 'verbose' },
  { label: 'Debug', value: 'debug' },
  { label: 'Silly', value: 'silly' },
  { label: 'Trace', value: 'trace' },
  { label: 'Fatal', value: 'fatal' },
]

const FORMAT_OPTIONS = [
  { label: 'Plain text (.log)', value: 'log' },
  { label: 'JSON (.json)', value: 'json' },
]

const ALL_SERVICES = ''
const ORDER_OPTIONS = [
  { label: 'Newest first', value: 'desc' },
  { label: 'Oldest first', value: 'asc' },
]
const WINDOW_OPTIONS = [
  { label: 'Retained log tail', value: 'all' },
  { label: 'Last 15 minutes', value: '15' },
  { label: 'Last hour', value: '60' },
  { label: 'Last 24 hours', value: '1440' },
]
type Query = { limit: string; service: string; level: string; order: 'asc' | 'desc'; search: string; window: string }

// After this long, tell the user the wait is expected rather than a hang.
const SLOW_HINT_MS = 8000

/**
 * Admin logs: a read-only tail of the server logs across all services, newest
 * first by default, colour-coded by level. Loaded lazily when Logs opens.
 * Service, level, message search, time window and order query the retained server
 * tail. Message filtering also applies immediately to the currently fetched rows.
 *
 * Loading UX: the first fetch (and any fetch that has no logs yet to show)
 * renders a skeleton in the log-list area only; a fetch that already has logs
 * on screen (Refresh / filter change) keeps them visible under a subtle
 * "Refreshing…" indicator. Log tailing can be slow, so after {@link SLOW_HINT_MS}
 * a reassuring hint appears. Requests run serially; filter changes queue only the
 * latest query. Account and request generations prevent stale responses from
 * replacing current rows or notifying the parent after sign-out or unmount.
 */
const AdminLogsTab: FunctionComponent<Props> = ({ application, noteIfForbidden }) => {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [slowHint, setSlowHint] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [limit, setLimit] = useState('200')
  const [service, setService] = useState(ALL_SERVICES)
  const [level, setLevel] = useState('')
  const [textFilter, setTextFilter] = useState('')
  const [exportFormat, setExportFormat] = useState<LogExportFormat>('log')
  const [order, setOrder] = useState<'asc' | 'desc'>('desc')
  const [timeWindow, setTimeWindow] = useState('all')
  const [search, setSearch] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [lastLoadedAt, setLastLoadedAt] = useState<string>()

  // Only the latest requested query can write state, even while a prior request drains.
  const requestRef = useRef(0)
  const mountedRef = useRef(true)
  const accountGenerationRef = useRef(0)
  const busyRef = useRef(false)
  const queuedRef = useRef<Query | undefined>(undefined)
  const loadRef = useRef<(options: Query) => Promise<void>>(async () => undefined)
  const latestQueryRef = useRef<Query>({ limit, service, level, order, search, window: timeWindow })
  latestQueryRef.current = { limit, service, level, order, search, window: timeWindow }
  const slowTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const load = useCallback<(options: Query) => Promise<void>>(
    async (options: Query) => {
      if (!mountedRef.current || !application.sessions.getUser()) {
        return
      }
      const requestId = ++requestRef.current
      if (busyRef.current) {
        queuedRef.current = options
        return
      }
      busyRef.current = true
      const accountUuid = application.sessions.getUser()?.uuid
      const accountGeneration = accountGenerationRef.current
      const isCurrent = () =>
        mountedRef.current &&
        requestId === requestRef.current &&
        accountGeneration === accountGenerationRef.current &&
        accountUuid === application.sessions.getUser()?.uuid

      setLoading(true)
      setLoadError(null)
      setSlowHint(false)
      if (slowTimerRef.current) {
        clearTimeout(slowTimerRef.current)
      }
      slowTimerRef.current = setTimeout(() => {
        if (isCurrent()) {
          setSlowHint(true)
        }
      }, SLOW_HINT_MS)

      try {
        const response = await application.legacyApi.adminGetLogs({
          limit: Number(options.limit),
          service: options.service || undefined,
          level: options.level || undefined,
          order: options.order,
          search: options.search || undefined,
          since:
            options.window === 'all' ? undefined : new Date(Date.now() - Number(options.window) * 60_000).toISOString(),
        })
        if (!isCurrent()) {
          return
        }
        if (isErrorResponse(response)) {
          noteIfForbidden(response)
          setLoadError('Server logs are not available on this server.')
          setEntries([])
          setTruncated(false)
          return
        }
        const data = (response as { data?: { entries?: LogEntry[]; truncated?: boolean } }).data
        setEntries(data?.entries ?? [])
        setTruncated(Boolean(data?.truncated))
        setLastLoadedAt(new Date().toISOString())
      } catch {
        if (!isCurrent()) {
          return
        }
        setLoadError('Could not load server logs.')
        setEntries([])
      } finally {
        busyRef.current = false
        if (isCurrent()) {
          setLoading(false)
          setSlowHint(false)
          if (slowTimerRef.current) {
            clearTimeout(slowTimerRef.current)
            slowTimerRef.current = undefined
          }
        }
        const queued = queuedRef.current
        queuedRef.current = undefined
        if (queued && mountedRef.current) {
          void loadRef.current(queued)
        }
      }
    },
    [application, noteIfForbidden],
  )
  loadRef.current = load

  // Clear any pending slow-hint timer on unmount and mark in-flight requests stale.
  useEffect(() => {
    mountedRef.current = true
    const reset = () => {
      accountGenerationRef.current += 1
      requestRef.current += 1
      queuedRef.current = undefined
      setEntries([])
      setTruncated(false)
      setLoadError(null)
      setLastLoadedAt(undefined)
      setTextFilter('')
      setSearch('')
      setService(ALL_SERVICES)
      setLevel('')
      setLoading(false)
      setSlowHint(false)
      if (slowTimerRef.current) {
        clearTimeout(slowTimerRef.current)
      }
    }
    reset()
    const dispose = application.addEventObserver(async (event) => {
      if (event === ApplicationEvent.SignedOut || event === ApplicationEvent.SignedIn) {
        reset()
      }
    })
    return () => {
      mountedRef.current = false
      dispose()
      requestRef.current += 1
      queuedRef.current = undefined
      if (slowTimerRef.current) {
        clearTimeout(slowTimerRef.current)
      }
    }
  }, [application])

  // Lazy-fetch on first open, and refetch when a server-side filter changes.
  useEffect(() => {
    void load(latestQueryRef.current)
  }, [load, limit, service, level, order, search, timeWindow])

  useEffect(() => {
    const generation = accountGenerationRef.current
    const timer = setTimeout(() => {
      if (mountedRef.current && generation === accountGenerationRef.current) {
        setSearch(textFilter.trim().slice(0, 256))
      }
    }, 350)
    return () => clearTimeout(timer)
  }, [textFilter])

  useEffect(() => {
    if (!autoRefresh) {
      return
    }
    const timer = setInterval(() => {
      if (!busyRef.current && !document.hidden) {
        void load(latestQueryRef.current)
      }
    }, 15_000)
    return () => clearInterval(timer)
  }, [autoRefresh, load])

  // Distinct services seen in the current page power the service dropdown; the
  // "All services" option is always present even before anything has loaded.
  const serviceOptions = useMemo(() => {
    const names = new Set<string>()
    for (const entry of entries) {
      if (entry.service) {
        names.add(entry.service)
      }
    }
    return [
      { label: 'All services', value: ALL_SERVICES },
      ...Array.from(names)
        .sort((a, b) => a.localeCompare(b))
        .map((name) => ({ label: name, value: name })),
    ]
  }, [entries])

  const visibleEntries = useMemo(
    () =>
      orderLogEntries(
        entries.filter((entry) => logMatchesText(entry, textFilter)),
        order,
      ),
    [entries, textFilter, order],
  )

  const downloadLogs = useCallback(() => {
    if (visibleEntries.length === 0) {
      return
    }
    const filename = logsExportFilename(exportFormat)
    if (exportFormat === 'json') {
      triggerBlobDownload(filename, logEntriesToJSON(visibleEntries), 'application/json;charset=utf-8')
    } else {
      triggerBlobDownload(filename, logEntriesToText(visibleEntries), 'text/plain;charset=utf-8')
    }
  }, [exportFormat, visibleEntries])

  // Skeleton only when there is nothing to keep on screen; an in-place refresh
  // keeps the existing lines visible under a subtle indicator instead.
  const showSkeleton = loading && entries.length === 0 && !loadError
  const showRefreshing = loading && entries.length > 0

  return (
    <PreferencesSegment>
      <Title>Server logs</Title>
      <Text>
        Read-only retained tail across services. Timestamps use UTC; legacy lines without a timestamp are marked
        unavailable. Search and filters query the retained tail, rather than the complete history. Logs may contain
        operational detail; treat them as sensitive. The limit selects the newest matching lines; ordering controls how
        those selected lines display.
      </Text>

      {/* Compact, aligned toolbar: the server-side query controls (service /
          level / limit) group on the left, the client-side message search grows
          to fill, and Refresh anchors the right — wrapping gracefully on narrow
          widths. The export controls sit on a lighter second row. */}
      <div className="border-border mt-3 rounded-md border p-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col">
            <Text className="text-passive-1 mb-1 text-xs font-medium">Service</Text>
            <Dropdown
              label="Log service filter"
              items={serviceOptions}
              value={service}
              onChange={setService}
              disabled={loading}
            />
          </div>
          <div className="flex flex-col">
            <Text className="text-passive-1 mb-1 text-xs font-medium">Level</Text>
            <Dropdown
              label="Log level filter"
              items={LEVEL_OPTIONS}
              value={level}
              onChange={setLevel}
              disabled={loading}
            />
          </div>
          <div className="flex flex-col">
            <Text className="text-passive-1 mb-1 text-xs font-medium">Limit</Text>
            <Dropdown label="Log limit" items={LIMIT_OPTIONS} value={limit} onChange={setLimit} disabled={loading} />
          </div>
          <div className="flex min-w-[220px] flex-grow flex-col">
            <Text className="text-passive-1 mb-1 text-xs font-medium">Search messages</Text>
            <DecoratedInput
              className={{ container: 'w-full' }}
              placeholder="Search retained messages…"
              value={textFilter}
              onChange={(value) => setTextFilter(value.slice(0, 256))}
            />
          </div>
          <Dropdown
            label="Log chronological order"
            items={ORDER_OPTIONS}
            value={order}
            onChange={(value) => setOrder(value as 'asc' | 'desc')}
          />
          <Dropdown label="Log time window" items={WINDOW_OPTIONS} value={timeWindow} onChange={setTimeWindow} />
          <Button label="Refresh" onClick={() => void load(latestQueryRef.current)} disabled={loading} />
          <Button
            label={autoRefresh ? 'Pause auto-refresh' : 'Start auto-refresh'}
            onClick={() => setAutoRefresh(!autoRefresh)}
          />
        </div>

        <div className="border-border mt-3 flex flex-wrap items-end gap-3 border-t pt-3">
          <div className="flex flex-col">
            <Text className="text-passive-1 mb-1 text-xs font-medium">Export format</Text>
            <Dropdown
              label="Log export format"
              items={FORMAT_OPTIONS}
              value={exportFormat}
              onChange={(value) => setExportFormat(value as LogExportFormat)}
              disabled={loading}
            />
          </div>
          <Button label="Download" onClick={downloadLogs} disabled={loading || visibleEntries.length === 0} />
          <Text className="text-passive-1 ml-auto max-w-xs pb-1.5 text-xs">
            Exports the lines currently shown (service, level and text filters applied).
          </Text>
        </div>
      </div>
      <Text className="text-passive-1 mt-2 text-xs">
        {autoRefresh ? 'Refreshes every 15 seconds while visible.' : 'Auto-refresh paused.'}
        {lastLoadedAt && ` Last refreshed: ${formatLogTimestampUTC(lastLoadedAt)}.`}
      </Text>

      {truncated && !loading && !loadError && (
        <Text className="mt-2 text-xs">
          The retained output exceeds this limit. Narrow the service, level, time window or message search.
        </Text>
      )}

      <HorizontalSeparator classes="my-3" />

      {showRefreshing && (
        <div className="mb-2 flex items-center gap-2" role="status" aria-live="polite">
          <Spinner className="h-3 w-3" />
          <Subtitle>Refreshing…</Subtitle>
        </div>
      )}

      {showSkeleton ? (
        <div className="border-border bg-contrast rounded border p-2">
          <Text className="text-passive-1 mb-2 text-xs">Loading server logs…</Text>
          <SkeletonList count={10} label="Loading server logs" rowClassName="max-w-full" />
          {slowHint && (
            <Text className="text-passive-1 mt-2 text-xs">Still loading… large log files can take a moment.</Text>
          )}
        </div>
      ) : loadError ? (
        <Text className="text-danger">{loadError}</Text>
      ) : entries.length === 0 ? (
        <Text>No log entries.</Text>
      ) : visibleEntries.length === 0 ? (
        <Text>No log entries match “{textFilter}”.</Text>
      ) : (
        <div className="border-border bg-contrast max-h-[28rem] overflow-auto rounded border p-2 font-mono text-xs">
          {visibleEntries.map((entry, index) => (
            <div
              key={`${entry.timestamp ?? ''}-${index}`}
              className={`py-0.5 break-words whitespace-pre-wrap ${logLevelColorClass(entry.level)}`}
            >
              <span className="text-passive-1">{formatLogTimestampUTC(entry.timestamp)} </span>
              {entry.level && <span className="font-bold">[{entry.level.toUpperCase()}] </span>}
              {entry.service && <span className="text-passive-0">{entry.service}: </span>}
              {entry.message}
            </div>
          ))}
        </div>
      )}

      {!showSkeleton && !loadError && entries.length > 0 && (
        <Subtitle className="mt-2">
          Showing {visibleEntries.length}
          {visibleEntries.length !== entries.length ? ` of ${entries.length}` : ''} line
          {entries.length === 1 ? '' : 's'}.
        </Subtitle>
      )}
    </PreferencesSegment>
  )
}

export default AdminLogsTab
