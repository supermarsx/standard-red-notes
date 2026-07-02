import { FunctionComponent, useCallback, useEffect, useState } from 'react'
import { isErrorResponse } from '@standardnotes/snjs'

import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Button from '@/Components/Button/Button'
import Spinner from '@/Components/Spinner/Spinner'

type AuditLogEntry = {
  uuid: string
  actorUuid: string | null
  action: string
  targetType: string | null
  targetUuid: string | null
  ip: string | null
  metadata: Record<string, unknown> | null
  createdAt: string
}

const PAGE_SIZE = 50

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
 */
const AdminAuditTab: FunctionComponent<Props> = ({ application, noteIfForbidden }) => {
  const [entries, setEntries] = useState<AuditLogEntry[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

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

      <div className="mt-3 flex items-center gap-3">
        <Button label="Refresh" onClick={() => void loadPage(offset)} disabled={loading} />
        {total > 0 && (
          <Text>
            Showing {entries.length === 0 ? 0 : offset + 1}&ndash;{offset + entries.length} of {total}
          </Text>
        )}
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
            return (
              <div key={entry.uuid} className="rounded border border-border p-2">
                <div className="flex items-center justify-between gap-2">
                  <Subtitle>{entry.action}</Subtitle>
                  <Text className="text-xs">{formatTimestamp(entry.createdAt)}</Text>
                </div>
                <Text className="text-xs">
                  Actor: {entry.actorUuid ?? 'anonymous'}
                  {entry.targetUuid ? (
                    <>
                      {' '}
                      &rarr; {entry.targetType ?? 'target'} {entry.targetUuid}
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
        <div className="mt-3 flex items-center gap-3">
          <Button
            label="Newer"
            onClick={() => void loadPage(Math.max(0, offset - PAGE_SIZE))}
            disabled={!hasNewer || loading}
          />
          <Button label="Older" onClick={() => void loadPage(offset + PAGE_SIZE)} disabled={!hasOlder || loading} />
        </div>
      )}
    </PreferencesSegment>
  )
}

export default AdminAuditTab
