import { useCallback, useEffect, useRef, useState } from 'react'
import { isErrorResponse } from '@standardnotes/snjs'
import type { WebApplication } from '@/Application/WebApplication'
import Button from '@/Components/Button/Button'
import { addToast, ToastType } from '@standardnotes/toast'

type Limits = Record<string, number>
type Policy = Limits & { users?: Record<string, Limits> }
type Field = { key: string; label: string; bytes?: boolean }
const globalFields: Field[] = [
  { key: 'maxCountPerItem', label: 'Revisions per note' },
  { key: 'retentionDays', label: 'Maximum age (days)' },
  { key: 'maxCountPerUser', label: 'Total revisions per user' },
  { key: 'maxBytesPerUser', label: 'Revision storage per user (MiB)', bytes: true },
  { key: 'maxCountTotal', label: 'Total revisions on this server' },
  { key: 'maxBytesTotal', label: 'Total revision storage (MiB)', bytes: true },
  { key: 'debounceSeconds', label: 'Combine autosaves within (seconds)' },
  { key: 'checkpointSeconds', label: 'Maximum checkpoint interval (seconds)' },
]
const userFields: Field[] = [
  { key: 'maxCountPerItem', label: 'Revisions per note' },
  { key: 'retentionDays', label: 'Maximum age (days)' },
  { key: 'maxCount', label: 'Total revisions for this user' },
  { key: 'maxBytes', label: 'Revision storage for this user (MiB)', bytes: true },
]

export default function AdminRevisionPolicy({
  application,
  userUuid,
  noteIfForbidden,
}: {
  application: WebApplication
  userUuid?: string
  noteIfForbidden: (response: { status?: number }) => void
}) {
  const [policy, setPolicy] = useState<Policy>()
  const [loadedFor, setLoadedFor] = useState<string>()
  const generation = useRef(0)
  const scope = userUuid ?? 'server'
  const ready = policy && loadedFor === scope
  const [values, setValues] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const fields = userUuid ? userFields : globalFields
  const receive = useCallback(
    (candidate: unknown) => {
      if (!candidate || typeof candidate !== 'object') {
        throw new Error('Revision policy is unavailable. Update the server and try again.')
      }
      const current = candidate as Policy
      setPolicy(current)
      setLoadedFor(userUuid ?? 'server')
      const source = userUuid ? (current.users?.[userUuid] ?? {}) : current
      setValues(
        Object.fromEntries(
          (userUuid ? userFields : globalFields).map((field) => [
            field.key,
            typeof source[field.key] === 'number' ? String(source[field.key] / (field.bytes ? 1048576 : 1)) : '',
          ]),
        ),
      )
    },
    [userUuid],
  )
  const load = useCallback(async () => {
    const request = ++generation.current
    setPolicy(undefined)
    setSaving(false)
    try {
      const response = await application.legacyApi.adminGetServerSettings()
      if (request !== generation.current) {
        return
      }
      const data = response.data as { settings?: { revisions?: unknown } } | undefined
      noteIfForbidden(response)
      if (isErrorResponse(response)) {
        throw new Error('Could not read revision limits.')
      }
      receive(data?.settings?.revisions)
      setError('')
    } catch (failure) {
      if (request === generation.current) {
        setError(failure instanceof Error ? failure.message : 'Could not read revision limits.')
      }
    }
  }, [application, noteIfForbidden, receive])
  const invalidateRequests = useCallback(() => {
    generation.current++
  }, [])
  useEffect(() => {
    void load()
    return invalidateRequests
  }, [load, invalidateRequests])
  const save = async (reset = false) => {
    if (!ready || saving) {
      return
    }
    const request = generation.current
    setSaving(true)
    try {
      const limits: Record<string, number | null> = {}
      for (const field of reset ? [] : fields) {
        const value = values[field.key]?.trim() ?? ''
        const number = Number(value) * (field.bytes ? 1048576 : 1)
        if (value && (!Number.isSafeInteger(number) || number < 0)) {
          throw new Error(`${field.label} must be a non-negative whole count or byte amount.`)
        }
        limits[field.key] = value ? number : null
      }
      const revisions = userUuid ? { users: { [userUuid]: reset ? null : limits } } : limits
      const response = await application.legacyApi.adminSetServerSettings({ revisions } as Parameters<
        WebApplication['legacyApi']['adminSetServerSettings']
      >[0])
      if (request !== generation.current) {
        return
      }
      const data = response.data as { settings?: { revisions?: unknown } } | undefined
      noteIfForbidden(response)
      if (isErrorResponse(response)) {
        throw new Error('Could not save revision limits.')
      }
      receive(data?.settings?.revisions)
      setError('')
      addToast({ type: ToastType.Success, message: 'Revision history limits saved.' })
    } catch (failure) {
      if (request === generation.current) {
        setError(failure instanceof Error ? failure.message : 'Could not save revision limits.')
      }
    } finally {
      if (request === generation.current) {
        setSaving(false)
      }
    }
  }
  return (
    <section
      aria-label={userUuid ? 'User revision history limits' : 'Server revision history limits'}
      className="flex flex-col gap-3"
    >
      <p className="text-passive-1 text-sm">
        Keep the newest revisions within the age limit. Both limits apply. Defaults are 200 revisions per note and 900
        days.
      </p>
      <p className="text-passive-1 text-xs">
        Oldest saved revisions are permanently removed when limits are exceeded. Current notes are kept. Zero means no
        additional limit; blank inherits the server setting or environment. User settings cannot exceed server caps.
      </p>
      {ready && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {fields.map((field) => (
            <label key={field.key} className="flex flex-col gap-1 text-sm">
              {field.label}
              <input
                type="number"
                min="0"
                step={field.bytes ? 'any' : '1'}
                value={values[field.key] ?? ''}
                placeholder={userUuid ? 'Inherit server limit' : 'Use environment/default'}
                disabled={saving}
                onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
                className="border-border bg-default text-text rounded border px-2 py-1"
              />
            </label>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="text-danger text-sm">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          label={saving ? 'Saving…' : 'Save revision limits'}
          disabled={!ready || saving}
          onClick={() => void save()}
        />
        {userUuid && <Button label="Use server limits" disabled={!ready || saving} onClick={() => void save(true)} />}
        {error && <Button label="Retry revision limits" onClick={() => void load()} />}
      </div>
    </section>
  )
}

export function AdminUserRevisionPolicy(props: Parameters<typeof AdminRevisionPolicy>[0]) {
  const [open, setOpen] = useState(false)
  return (
    <details className="border-border rounded-lg border p-3" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-sm font-semibold">Revision history limits</summary>
      {open && (
        <div className="mt-3">
          <AdminRevisionPolicy {...props} />
        </div>
      )}
    </details>
  )
}
