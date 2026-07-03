import { FunctionComponent, useCallback, useEffect, useState } from 'react'
import { isErrorResponse } from '@standardnotes/snjs'

import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Button from '@/Components/Button/Button'
import Dropdown from '@/Components/Dropdown/Dropdown'
import Switch from '@/Components/Switch/Switch'
import Spinner from '@/Components/Spinner/Spinner'
import AdminPagination from './AdminPagination'
import { ADMIN_USERS_MAX_LIMIT } from './adminHelpers'
import {
  AuditExportEntry,
  AuditExportFormat,
  auditEntriesToCSV,
  auditEntriesToJSON,
  auditExportFilename,
  triggerBlobDownload,
} from './adminExportUtils'

type AuditLogEntry = AuditExportEntry

const PAGE_SIZE = 50

const FORMAT_OPTIONS = [
  { label: 'CSV (.csv)', value: 'csv' },
  { label: 'JSON (.json)', value: 'json' },
]

/**
 * Compact, E2E-safe one-liner for an entry's metadata (the server already
 * withholds sensitive values — this only renders what it was given).
 */
const describeMetadata = (metadata: Record<string, unknown> | null): string => {
  if (!metadata) {
    return ''
  }
  const parts = Object.entries(metadata)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
  return parts.join(', ')
}

const formatTimestamp = (createdAt: string): string => {
  const date = new Date(createdAt)
  return Number.isNaN(date.getTime()) ? createdAt : date.toLocaleString()
}

type Props = {
  application: WebApplication
  noteIfForbidden: (response: { status?: number }) => void
}

/**
 * Admin audit log: a paginated, newest-first view over the server's admin
 * audit-log endpoint (sign-ins, role/ban/setting changes, webhook management,
 * MFA resets, quota recalculations...). Loaded lazily — this component only
 * mounts when the Audit log tab is opened.
 *
 * The audit payload carries only uuids for the actor and target. When "Show
 * friendly names" is on, uuids are resolved to emails via a best-effort
 * uuid->email map built from the existing admin users-list endpoint (no new
 * server route). A uuid the map does not cover degrades gracefully to the raw
 * identifier.
 */
const AdminAuditTab: FunctionComponent<Props> = ({ application, noteIfForbidden }) => {
  const [entries, setEntries] = useState<AuditLogEntry[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [exportFormat, setExportFormat] = useState<AuditExportFormat>('csv')

  // Filter state (persisted for the life of the tab): render friendly
  // names/emails for actor & target uuids, or the raw identifiers.
  const [showFriendlyNames, setShowFriendlyNames] = useState(true)
  // Best-effort uuid -> email map, loaded once (lazily, when friendly names are
  // first requested) from the admin users list. `null` = not yet attempted.
  const [emailByUuid, setEmailByUuid] = useState<Record<string, string> | null>(null)
  const [namesLoading, setNamesLoading] = useState(false)

  const loadPage = useCallback(
    async (pageOffset: number) => {
      setLoading(true)
      setLoadError(null)
      try {
        const response = await application.legacyApi.adminGetAuditLog({ limit: PAGE_SIZE, offset: pageOffset })
        if (isErrorResponse(response)) {
          noteIfForbidden(response)
          setLoadError('Could not load the audit log. It may not be enabled on this server.')
          return
        }
        const data = (
          response as {
            data?: { entries?: AuditLogEntry[]; total?: number; offset?: number }
          }
        ).data
        setEntries(data?.entries ?? [])
        setTotal(data?.total ?? 0)
        setOffset(data?.offset ?? pageOffset)
      } catch (error) {
        console.error(error)
        setLoadError('Could not load the audit log.')
      } finally {
        setLoading(false)
      }
    },
    [application, noteIfForbidden],
  )

  useEffect(() => {
    void loadPage(0)
  }, [loadPage])

  // Build the uuid->email map once, lazily, the first time friendly names are
  // wanted. Uses the existing admin users-list endpoint (best-effort: covers up
  // to the server's page cap of the most-recent users). No new server route.
  const loadEmailMap = useCallback(async () => {
    setNamesLoading(true)
    try {
      const response = await application.legacyApi.adminListUsers({
        limit: ADMIN_USERS_MAX_LIMIT,
        offset: 0,
        sort: '-createdAt',
      })
      if (isErrorResponse(response)) {
        // Degrade gracefully: leave the map empty so uuids render raw.
        setEmailByUuid({})
        return
      }
      const users = (response as { data?: { users?: Array<{ uuid: string; email: string }> } }).data?.users ?? []
      const map: Record<string, string> = {}
      for (const user of users) {
        if (user.uuid && user.email) {
          map[user.uuid] = user.email
        }
      }
      setEmailByUuid(map)
    } catch (error) {
      console.error(error)
      setEmailByUuid({})
    } finally {
      setNamesLoading(false)
    }
  }, [application])

  useEffect(() => {
    if (showFriendlyNames && emailByUuid === null && !namesLoading) {
      void loadEmailMap()
    }
  }, [showFriendlyNames, emailByUuid, namesLoading, loadEmailMap])

  // Resolve a uuid to its email when friendly names are on and the uuid is
  // covered by the map; otherwise fall back to the raw uuid.
  const friendlyFor = useCallback(
    (uuid: string): string => {
      if (!showFriendlyNames || !emailByUuid) {
        return uuid
      }
      return emailByUuid[uuid] ?? uuid
    },
    [showFriendlyNames, emailByUuid],
  )

  const downloadAudit = useCallback(() => {
    if (entries.length === 0) {
      return
    }
    const filename = auditExportFilename(exportFormat)
    if (exportFormat === 'json') {
      triggerBlobDownload(filename, auditEntriesToJSON(entries), 'application/json;charset=utf-8')
    } else {
      triggerBlobDownload(filename, auditEntriesToCSV(entries), 'text/csv;charset=utf-8')
    }
  }, [entries, exportFormat])

  const hasNewer = offset > 0
  const hasOlder = offset + PAGE_SIZE < total

  return (
    <PreferencesSegment>
      <Title>Audit log</Title>
      <Text>
        Server-side record of security-relevant events: sign-ins, admin actions (role, ban and setting changes, 2FA
        resets, quota recalculations) and webhook management. Newest first. Setting values are never recorded — only
        which setting changed.
      </Text>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button label="Refresh" onClick={() => void loadPage(offset)} disabled={loading} />
        {total > 0 && (
          <Text>
            Showing {entries.length === 0 ? 0 : offset + 1}&ndash;{offset + entries.length} of {total}
          </Text>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Text className="text-xs text-passive-1">Show friendly names{namesLoading ? ' (loading…)' : ''}</Text>
          <Switch checked={showFriendlyNames} onChange={setShowFriendlyNames} />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Dropdown
          label="Audit export format"
          items={FORMAT_OPTIONS}
          value={exportFormat}
          onChange={(value) => setExportFormat(value as AuditExportFormat)}
          disabled={loading}
        />
        <Button label="Download" onClick={downloadAudit} disabled={loading || entries.length === 0} />
        <Text className="text-xs text-passive-1">
          Exports the current page ({entries.length} {entries.length === 1 ? 'entry' : 'entries'}). Use the pager to move
          through pages and download each.
        </Text>
      </div>

      <HorizontalSeparator classes="my-3" />

      {loading ? (
        <Spinner className="h-5 w-5" />
      ) : loadError ? (
        <Text className="text-danger">{loadError}</Text>
      ) : entries.length === 0 ? (
        <Text>No audit entries yet.</Text>
      ) : (
        <div className="flex flex-col gap-2">
          {entries.map((entry) => {
            const metadataSummary = describeMetadata(entry.metadata)
            const actorLabel = entry.actorUuid ? friendlyFor(entry.actorUuid) : 'anonymous'
            // Only a "user" target is a person to resolve; other target types
            // (webhook, setting, …) keep their raw identifier.
            const targetLabel =
              entry.targetUuid && entry.targetType === 'user' ? friendlyFor(entry.targetUuid) : entry.targetUuid
            return (
              <div key={entry.uuid} className="rounded border border-border p-2">
                <div className="flex items-center justify-between gap-2">
                  <Subtitle>{entry.action}</Subtitle>
                  <Text className="text-xs">{formatTimestamp(entry.createdAt)}</Text>
                </div>
                <Text className="text-xs">
                  Actor: {actorLabel}
                  {entry.targetUuid ? (
                    <>
                      {' '}
                      &rarr; {entry.targetType ?? 'target'} {targetLabel}
                    </>
                  ) : null}
                  {entry.ip ? <> &middot; from {entry.ip}</> : null}
                </Text>
                {metadataSummary && <Text className="text-xs">{metadataSummary}</Text>}
              </div>
            )
          })}
        </div>
      )}

      {(hasNewer || hasOlder) && !loading && !loadError && (
        <AdminPagination
          className="mt-3"
          previousLabel="Newer entries"
          nextLabel="Older entries"
          previousDisabled={!hasNewer || loading}
          nextDisabled={!hasOlder || loading}
          onPrevious={() => void loadPage(Math.max(0, offset - PAGE_SIZE))}
          onNext={() => void loadPage(offset + PAGE_SIZE)}
        />
      )}
    </PreferencesSegment>
  )
}

export default AdminAuditTab
