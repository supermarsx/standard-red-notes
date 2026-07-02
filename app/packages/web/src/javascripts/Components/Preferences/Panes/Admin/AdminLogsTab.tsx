import { FunctionComponent, useCallback, useEffect, useMemo, useState } from 'react'
import { isErrorResponse } from '@standardnotes/snjs'

import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Button from '@/Components/Button/Button'
import Dropdown from '@/Components/Dropdown/Dropdown'
import DecoratedInput from '@/Components/Input/DecoratedInput'
import Spinner from '@/Components/Spinner/Spinner'
import {
  LogEntry,
  formatLogTimestamp,
  logLevelColorClass,
  logMatchesText,
} from './adminHelpers'

type Props = {
  application: WebApplication
  noteIfForbidden: (response: { status?: number }) => void
}

// The server clamps to 500; offer the common tail sizes.
const LIMIT_OPTIONS = [
  { label: 'Last 100', value: '100' },
  { label: 'Last 200', value: '200' },
  { label: 'Last 500', value: '500' },
]

const LEVEL_OPTIONS = [
  { label: 'All levels', value: '' },
  { label: 'Error', value: 'error' },
  { label: 'Warn', value: 'warn' },
  { label: 'Info', value: 'info' },
  { label: 'Debug', value: 'debug' },
]

const ALL_SERVICES = ''

/**
 * Admin logs: a read-only tail of the server logs across all services, newest
 * first, colour-coded by level. Loaded lazily — this component only mounts when
 * the Logs tab is opened. The service and level filters are applied server-side
 * (a refetch); the free-text box filters the already-fetched lines client-side.
 */
const AdminLogsTab: FunctionComponent<Props> = ({ application, noteIfForbidden }) => {
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [limit, setLimit] = useState('200')
  const [service, setService] = useState(ALL_SERVICES)
  const [level, setLevel] = useState('')
  const [textFilter, setTextFilter] = useState('')

  const load = useCallback(
    async (options: { limit: string; service: string; level: string }) => {
      setLoading(true)
      setLoadError(null)
      try {
        const response = await application.legacyApi.adminGetLogs({
          limit: Number(options.limit),
          service: options.service || undefined,
          level: options.level || undefined,
        })
        if (isErrorResponse(response)) {
          noteIfForbidden(response)
          setLoadError('Server logs are not available on this server.')
          setEntries([])
          return
        }
        const data = (response as { data?: { entries?: LogEntry[]; truncated?: boolean } }).data
        setEntries(data?.entries ?? [])
        setTruncated(Boolean(data?.truncated))
      } catch (error) {
        console.error(error)
        setLoadError('Could not load server logs.')
        setEntries([])
      } finally {
        setLoading(false)
      }
    },
    [application, noteIfForbidden],
  )

  // Lazy-fetch on first open, and refetch when a server-side filter changes.
  useEffect(() => {
    void load({ limit, service, level })
  }, [load, limit, service, level])

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
    () => entries.filter((entry) => logMatchesText(entry, textFilter)),
    [entries, textFilter],
  )

  return (
    <PreferencesSegment>
      <Title>Server logs</Title>
      <Text>
        Read-only tail of the server logs across all services, newest first. Filter by service and level (re-queries the
        server) or type to filter the fetched lines. Logs may contain operational detail; treat them as sensitive.
      </Text>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Dropdown
          label="Log service filter"
          items={serviceOptions}
          value={service}
          onChange={setService}
          disabled={loading}
        />
        <Dropdown label="Log level filter" items={LEVEL_OPTIONS} value={level} onChange={setLevel} disabled={loading} />
        <Dropdown label="Log limit" items={LIMIT_OPTIONS} value={limit} onChange={setLimit} disabled={loading} />
        <DecoratedInput
          className={{ container: 'w-56' }}
          placeholder="Filter messages…"
          value={textFilter}
          onChange={setTextFilter}
        />
        <Button label="Refresh" onClick={() => void load({ limit, service, level })} disabled={loading} />
      </div>

      {truncated && !loading && !loadError && (
        <Text className="mt-2 text-xs">
          Output was truncated by the server; narrow the filters or lower the limit to see more specific lines.
        </Text>
      )}

      <HorizontalSeparator classes="my-3" />

      {loading ? (
        <Spinner className="h-5 w-5" />
      ) : loadError ? (
        <Text className="text-danger">{loadError}</Text>
      ) : entries.length === 0 ? (
        <Text>No log entries.</Text>
      ) : visibleEntries.length === 0 ? (
        <Text>No log entries match “{textFilter}”.</Text>
      ) : (
        <div className="max-h-[28rem] overflow-auto rounded border border-border bg-contrast p-2 font-mono text-xs">
          {visibleEntries.map((entry, index) => (
            <div
              key={`${entry.timestamp ?? ''}-${index}`}
              className={`whitespace-pre-wrap break-words py-0.5 ${logLevelColorClass(entry.level)}`}
            >
              {formatLogTimestamp(entry.timestamp) && (
                <span className="text-passive-1">{formatLogTimestamp(entry.timestamp)} </span>
              )}
              {entry.level && <span className="font-bold">[{entry.level.toUpperCase()}] </span>}
              {entry.service && <span className="text-passive-0">{entry.service}: </span>}
              {entry.message}
            </div>
          ))}
        </div>
      )}

      {!loading && !loadError && entries.length > 0 && (
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
