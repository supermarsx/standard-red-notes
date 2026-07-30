import { FunctionComponent, useCallback, useEffect, useMemo, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { SettingName, isErrorResponse } from '@standardnotes/snjs'
import { ToastType, addToast } from '@standardnotes/toast'

import { WebApplication } from '@/Application/WebApplication'
import Button from '@/Components/Button/Button'
import DecoratedInput from '@/Components/Input/DecoratedInput'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesGroup from '@/Components/Preferences/PreferencesComponents/PreferencesGroup'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Spinner from '@/Components/Spinner/Spinner'
import Switch from '@/Components/Switch/Switch'
import CopyButton from '../TwoFactorAuth/CopyButton'
import {
  DATE_ONLY_PATTERN,
  convertTemporalInputMode,
  formatCalendarValue,
  parseTemporalInput,
  temporalInputValue,
  temporalRangeError,
} from './caldavTime'

type Props = {
  application: WebApplication
}

type CaldavToken = {
  uuid: string
  label: string
  scope: string
  createdAt: number | string | null
  lastUsedAt: number | string | null
}

type PublishedCaldavTodo = {
  uid: string
  summary: string
  description?: string
  due?: string
  start?: string
  completed?: boolean
  completedAt?: string
  priority?: number
  createdAt?: number
  updatedAt?: number
}

const CALDAV_ENABLED_NAME = 'CALDAV_ENABLED'
const caldavEnabledSettingName = { value: CALDAV_ENABLED_NAME } as unknown as SettingName

const CalDavTokens: FunctionComponent<Props> = ({ application }: Props) => {
  const [isLoading, setIsLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [serverEnabled, setServerEnabled] = useState(false)
  const [optIn, setOptIn] = useState(false)
  const [basePath, setBasePath] = useState('/dav')
  const [tokens, setTokens] = useState<CaldavToken[]>([])
  const [todos, setTodos] = useState<PublishedCaldavTodo[]>([])
  const [label, setLabel] = useState('')
  const [creating, setCreating] = useState(false)
  const [createdToken, setCreatedToken] = useState<string | null>(null)
  const [editingUid, setEditingUid] = useState<string | undefined>()
  const [summary, setSummary] = useState('')
  const [description, setDescription] = useState('')
  const [startLocal, setStartLocal] = useState('')
  const [startDateOnly, setStartDateOnly] = useState(false)
  const [dueLocal, setDueLocal] = useState('')
  const [dueDateOnly, setDueDateOnly] = useState(false)
  const [completed, setCompleted] = useState(false)
  const [completedAtLocal, setCompletedAtLocal] = useState('')
  const [priority, setPriority] = useState('')
  const [publishing, setPublishing] = useState(false)

  const userUuid = application.sessions.getUser()?.uuid
  const subscriptionUrl = useMemo(() => {
    return userUuid
      ? `${application.legacyApi.getHost().replace(/\/$/, '')}${basePath}/calendars/${encodeURIComponent(
          userUuid,
        )}/todos/`
      : ''
  }, [application, basePath, userUuid])

  const loadTokens = useCallback(async (): Promise<boolean> => {
    try {
      const response = await application.legacyApi.listCaldavTokens()
      if (!isErrorResponse(response)) {
        const data = (response as { data?: { tokens?: CaldavToken[] } }).data
        setTokens(data?.tokens ?? [])
        return true
      }
    } catch (error) {
      console.error(error)
    }
    setTokens([])
    return false
  }, [application])

  const loadTodos = useCallback(async (): Promise<boolean> => {
    try {
      const response = await application.legacyApi.listCaldavTodos()
      if (!isErrorResponse(response)) {
        const data = (response as { data?: { todos?: PublishedCaldavTodo[] } }).data
        setTodos(data?.todos ?? [])
        return true
      }
    } catch (error) {
      console.error(error)
    }
    setTodos([])
    return false
  }, [application])

  const load = useCallback(async () => {
    setIsLoading(true)
    setLoadError(false)
    try {
      const response = await application.legacyApi.getCaldavConfig()
      if (!isErrorResponse(response)) {
        const data = (
          response as {
            data?: { caldavEnabled?: boolean; allowed?: boolean; basePath?: string }
          }
        ).data
        setServerEnabled(Boolean(data?.caldavEnabled))
        setOptIn(Boolean(data?.allowed))
        if (typeof data?.basePath === 'string' && data.basePath.startsWith('/')) {
          setBasePath(data.basePath.replace(/\/+$/, ''))
        }
      } else {
        setServerEnabled(false)
        setOptIn(false)
        setBasePath('/dav')
        setLoadError(true)
      }
      // Listing is deliberately available when the feature is disabled so users
      // can still remove retained plaintext and revoke credentials.
      const [tokensLoaded, todosLoaded] = await Promise.all([loadTokens(), loadTodos()])
      setLoadError((current) => current || !tokensLoaded || !todosLoaded)
    } catch (error) {
      console.error(error)
      setServerEnabled(false)
      setOptIn(false)
      setBasePath('/dav')
      setTokens([])
      setTodos([])
      setLoadError(true)
    } finally {
      setIsLoading(false)
    }
  }, [application, loadTodos, loadTokens])

  useEffect(() => {
    void load()
  }, [load])

  const handleToggleOptIn = useCallback(async () => {
    const next = !optIn
    try {
      if (!next) {
        // Revoke first: if the setting update later fails, no credential remains
        // live. Cleanup is server-supported even while either gate is disabled.
        const revokeResponse = await application.legacyApi.deleteAllCaldavTokens()
        if (isErrorResponse(revokeResponse)) {
          throw new Error('The server could not revoke existing CalDAV tokens.')
        }
        setTokens([])
        setCreatedToken(null)
      }
      await application.settings.updateSetting(caldavEnabledSettingName, next ? 'true' : 'false', false)
      setOptIn(next)
    } catch (error) {
      console.error(error)
      addToast({
        type: ToastType.Error,
        message: next
          ? 'Failed to enable CalDAV access.'
          : 'CalDAV tokens may have been revoked, but the account setting could not be disabled.',
      })
    }
  }, [application, optIn])

  const handleCreate = useCallback(async () => {
    const trimmed = label.trim()
    if (trimmed.length === 0) {
      addToast({ type: ToastType.Error, message: 'Please enter a label for the CalDAV token.' })
      return
    }
    setCreating(true)
    try {
      const response = await application.legacyApi.createCaldavToken({ label: trimmed })
      if (isErrorResponse(response)) {
        const data = response.data as { error?: { message?: string } } | undefined
        addToast({ type: ToastType.Error, message: data?.error?.message ?? 'Failed to create CalDAV token.' })
        return
      }
      const data = (response as { data?: { token?: { token?: string } } }).data
      const token = data?.token?.token
      if (!token) {
        addToast({ type: ToastType.Error, message: 'The server did not return a token.' })
        return
      }
      setCreatedToken(token)
      setLabel('')
      await loadTokens()
    } catch (error) {
      console.error(error)
      addToast({ type: ToastType.Error, message: 'Failed to create CalDAV token.' })
    } finally {
      setCreating(false)
    }
  }, [application, label, loadTokens])

  const handleDeleteToken = useCallback(
    async (tokenUuid: string) => {
      const confirmed = await application.alerts.confirm(
        'Are you sure you want to revoke this CalDAV token? The calendar app using it will lose access.',
        'Revoke CalDAV Token',
        'Revoke',
      )
      if (!confirmed) {
        return
      }
      try {
        const response = await application.legacyApi.deleteCaldavToken(tokenUuid)
        if (isErrorResponse(response)) {
          addToast({ type: ToastType.Error, message: 'Failed to revoke CalDAV token.' })
          return
        }
        await loadTokens()
      } catch (error) {
        console.error(error)
        addToast({ type: ToastType.Error, message: 'Failed to revoke CalDAV token.' })
      }
    },
    [application, loadTokens],
  )

  const clearTodoForm = useCallback(() => {
    setEditingUid(undefined)
    setSummary('')
    setDescription('')
    setStartLocal('')
    setStartDateOnly(false)
    setDueLocal('')
    setDueDateOnly(false)
    setCompleted(false)
    setCompletedAtLocal('')
    setPriority('')
  }, [])

  const handlePublish = useCallback(async () => {
    const trimmedSummary = summary.trim()
    if (!trimmedSummary) {
      addToast({ type: ToastType.Error, message: 'Enter a summary for the calendar item.' })
      return
    }
    let start: string | undefined
    let due: string | undefined
    let completedAt: string | undefined
    try {
      start = parseTemporalInput(startLocal, 'start', startDateOnly)
      due = parseTemporalInput(dueLocal, 'due', dueDateOnly)
      completedAt = completed ? parseTemporalInput(completedAtLocal, 'completion') : undefined
    } catch (error) {
      addToast({ type: ToastType.Error, message: (error as Error).message })
      return
    }
    const rangeError = temporalRangeError(start, due, startDateOnly, dueDateOnly)
    if (rangeError) {
      addToast({ type: ToastType.Error, message: rangeError })
      return
    }
    let parsedPriority: number | undefined
    if (priority !== '') {
      parsedPriority = Number(priority)
      if (!Number.isInteger(parsedPriority) || parsedPriority < 0 || parsedPriority > 9) {
        addToast({ type: ToastType.Error, message: 'Priority must be a whole number from 0 to 9.' })
        return
      }
    }
    setPublishing(true)
    try {
      const response = await application.legacyApi.publishCaldavTodo({
        ...(editingUid ? { uid: editingUid } : {}),
        summary: trimmedSummary,
        ...(description.length > 0 ? { description } : {}),
        ...(start ? { start } : {}),
        ...(due ? { due } : {}),
        completed,
        ...(completedAt ? { completedAt } : {}),
        ...(parsedPriority !== undefined ? { priority: parsedPriority } : {}),
      })
      if (isErrorResponse(response)) {
        const data = response.data as { error?: { message?: string } } | undefined
        addToast({ type: ToastType.Error, message: data?.error?.message ?? 'Failed to publish calendar item.' })
        return
      }
      clearTodoForm()
      await loadTodos()
    } catch (error) {
      console.error(error)
      addToast({ type: ToastType.Error, message: 'Failed to publish calendar item.' })
    } finally {
      setPublishing(false)
    }
  }, [
    application,
    clearTodoForm,
    completed,
    completedAtLocal,
    description,
    dueLocal,
    editingUid,
    loadTodos,
    priority,
    dueDateOnly,
    startLocal,
    startDateOnly,
    summary,
  ])

  const handleEditTodo = useCallback((todo: PublishedCaldavTodo) => {
    const existingStartDateOnly = Boolean(todo.start && DATE_ONLY_PATTERN.test(todo.start))
    const existingDueDateOnly = Boolean(todo.due && DATE_ONLY_PATTERN.test(todo.due))
    setEditingUid(todo.uid)
    setSummary(todo.summary)
    setDescription(todo.description ?? '')
    setStartLocal(temporalInputValue(todo.start))
    setStartDateOnly(existingStartDateOnly)
    setDueLocal(temporalInputValue(todo.due))
    setDueDateOnly(existingDueDateOnly)
    setCompleted(Boolean(todo.completed))
    setCompletedAtLocal(temporalInputValue(todo.completedAt))
    setPriority(todo.priority === undefined ? '' : `${todo.priority}`)
  }, [])

  const handleUnpublish = useCallback(
    async (todo: PublishedCaldavTodo) => {
      const confirmed = await application.alerts.confirm(
        `Remove “${todo.summary}” from the plaintext CalDAV feed?`,
        'Unpublish Calendar Item',
        'Unpublish',
      )
      if (!confirmed) {
        return
      }
      try {
        const response = await application.legacyApi.deleteCaldavTodo(todo.uid)
        if (isErrorResponse(response)) {
          addToast({ type: ToastType.Error, message: 'Failed to unpublish calendar item.' })
          return
        }
        if (editingUid === todo.uid) {
          clearTodoForm()
        }
        await loadTodos()
      } catch (error) {
        console.error(error)
        addToast({ type: ToastType.Error, message: 'Failed to unpublish calendar item.' })
      }
    },
    [application, clearTodoForm, editingUid, loadTodos],
  )

  const canAddData = serverEnabled && optIn && !isLoading

  return (
    <PreferencesGroup>
      <PreferencesSegment>
        <Title>CalDAV Access</Title>
        <Text>
          Publish selected to-dos to a read-only calendar without exposing your encrypted notes. Dedicated calendar
          tokens are shown once and never contain your account password.
        </Text>
        <div className="border-warning bg-warning-faded mt-3 rounded border border-solid p-3">
          <Subtitle className="text-warning">Privacy warning: published calendar fields are server-readable</Subtitle>
          <Text className="mt-1">
            A published summary, description, start, due date, completion state, and priority leave end-to-end
            encryption and are stored as plaintext so ordinary CalDAV clients can read them.
          </Text>
        </div>

        {isLoading ? (
          <Spinner className="mt-3 h-4 w-4" />
        ) : loadError ? (
          <div className="border-warning bg-warning-faded mt-3 rounded border border-solid p-3">
            <Subtitle className="text-warning">CalDAV status is unavailable</Subtitle>
            <Text className="mt-1">
              The app cleared cached CalDAV status, credentials, and published-item results because one or more server
              requests failed. Retry before making access decisions.
            </Text>
            <Button className="mt-2" label="Retry" onClick={() => void load()} />
          </div>
        ) : !serverEnabled ? (
          <Text className="mt-2">
            CalDAV is disabled on this server. You can still revoke old tokens and delete retained published items
            below.
          </Text>
        ) : (
          <div className="mt-4 flex items-center justify-between">
            <div className="flex flex-col">
              <Subtitle>Allow CalDAV access</Subtitle>
              <Text>
                Turning this off here revokes every current CalDAV token before disabling new publication. An
                administrator changing the underlying account setting elsewhere cannot dynamically reach an already
                authenticated Basic client; revoke tokens here as well.
              </Text>
            </div>
            <Switch onChange={() => void handleToggleOptIn()} checked={optIn} />
          </div>
        )}
      </PreferencesSegment>

      {canAddData && (
        <>
          <HorizontalSeparator classes="my-4" />
          <PreferencesSegment>
            <Subtitle>{editingUid ? 'Edit published to-do' : 'Publish a to-do'}</Subtitle>
            <Text className="mb-2">
              Only these explicit fields leave the encrypted notebook and enter the server-readable calendar store.
            </Text>
            <div className="flex flex-col gap-2">
              <DecoratedInput placeholder="Summary" value={summary} onChange={setSummary} disabled={publishing} />
              <DecoratedInput
                placeholder="Description (optional)"
                value={description}
                onChange={setDescription}
                disabled={publishing}
              />
              <div className="flex items-center justify-between">
                <Text>Start uses a date only</Text>
                <Switch
                  checked={startDateOnly}
                  onChange={() => {
                    const next = !startDateOnly
                    setStartLocal((current) => convertTemporalInputMode(current, next))
                    setStartDateOnly(next)
                  }}
                />
              </div>
              <DecoratedInput
                title={startDateOnly ? 'Start date (optional)' : 'Start date and time (optional)'}
                type={startDateOnly ? 'date' : 'datetime-local'}
                value={startLocal}
                onChange={setStartLocal}
                disabled={publishing}
              />
              <div className="flex items-center justify-between">
                <Text>Due uses a date only</Text>
                <Switch
                  checked={dueDateOnly}
                  onChange={() => {
                    const next = !dueDateOnly
                    setDueLocal((current) => convertTemporalInputMode(current, next))
                    setDueDateOnly(next)
                  }}
                />
              </div>
              <DecoratedInput
                title={dueDateOnly ? 'Due date (optional)' : 'Due date and time (optional)'}
                type={dueDateOnly ? 'date' : 'datetime-local'}
                value={dueLocal}
                onChange={setDueLocal}
                disabled={publishing}
              />
              <DecoratedInput
                title="Priority (0 means unspecified, 1 is highest, 9 is lowest)"
                type="number"
                placeholder="Priority 0–9 (optional)"
                value={priority}
                onChange={setPriority}
                disabled={publishing}
              />
              <div className="flex items-center justify-between">
                <Text>Completed</Text>
                <Switch
                  checked={completed}
                  onChange={() => {
                    setCompleted((current) => !current)
                    if (completed) {
                      setCompletedAtLocal('')
                    }
                  }}
                />
              </div>
              {completed && (
                <DecoratedInput
                  title="Completion date and time (optional)"
                  type="datetime-local"
                  value={completedAtLocal}
                  onChange={setCompletedAtLocal}
                  disabled={publishing}
                />
              )}
              <div className="flex flex-row gap-2">
                <Button
                  label={editingUid ? 'Save changes' : 'Publish'}
                  primary
                  disabled={publishing}
                  onClick={() => void handlePublish()}
                />
                {editingUid && <Button label="Cancel" disabled={publishing} onClick={clearTodoForm} />}
              </div>
            </div>
          </PreferencesSegment>

          <HorizontalSeparator classes="my-4" />
          <PreferencesSegment>
            <Subtitle>Create a new CalDAV token</Subtitle>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
              <DecoratedInput
                className={{ container: 'min-w-0 flex-grow' }}
                placeholder="Label (e.g. Apple Calendar)"
                value={label}
                onChange={setLabel}
                disabled={creating}
              />
              <Button className="flex-shrink-0" label="Create" primary disabled={creating} onClick={handleCreate} />
            </div>

            {createdToken && (
              <div className="border-border mt-3 rounded border border-solid p-3">
                <Subtitle>Copy your new CalDAV token now</Subtitle>
                <Text className="mb-2">This secret will not be shown again.</Text>
                <div className="flex flex-row items-center gap-2">
                  <code className="bg-contrast rounded px-2 py-1 text-sm break-all select-text">{createdToken}</code>
                  <CopyButton copyValue={createdToken} successMessage="CalDAV token copied to clipboard" />
                </div>
              </div>
            )}
          </PreferencesSegment>
        </>
      )}

      {serverEnabled && subscriptionUrl && (
        <>
          <HorizontalSeparator classes="my-4" />
          <PreferencesSegment>
            <Subtitle>Calendar collection URL</Subtitle>
            <Text className="mb-2">
              Use any non-empty username and a CalDAV token as the password. Use HTTPS outside a trusted local network.
            </Text>
            <div className="flex flex-row items-center gap-2">
              <code className="bg-contrast rounded px-2 py-1 text-sm break-all select-text">{subscriptionUrl}</code>
              <CopyButton copyValue={subscriptionUrl} successMessage="Subscription URL copied to clipboard" />
            </div>
          </PreferencesSegment>
        </>
      )}

      <HorizontalSeparator classes="my-4" />
      <PreferencesSegment>
        <Subtitle>Published plaintext items</Subtitle>
        {todos.length === 0 && <Text className="mt-2">No to-dos are published to CalDAV.</Text>}
        {todos.map((todo) => (
          <div
            key={todo.uid}
            className="border-border mt-2 flex flex-col gap-2 rounded border border-solid p-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex min-w-0 flex-col">
              <span className="text-base font-medium break-words lg:text-sm">{todo.summary}</span>
              <span className="text-passive-0 text-sm break-words lg:text-xs">
                {todo.due ? `Due ${formatCalendarValue(todo.due)}` : 'No due date'} · Updated{' '}
                {formatCalendarValue(todo.updatedAt)}
              </span>
            </div>
            <div className="flex flex-row gap-2">
              {canAddData && <Button className="flex-shrink-0" label="Edit" onClick={() => handleEditTodo(todo)} />}
              <Button className="flex-shrink-0" label="Unpublish" onClick={() => void handleUnpublish(todo)} />
            </div>
          </div>
        ))}
      </PreferencesSegment>

      <HorizontalSeparator classes="my-4" />
      <PreferencesSegment>
        <Subtitle>Your CalDAV tokens</Subtitle>
        {tokens.length === 0 && <Text className="mt-2">You have no CalDAV tokens.</Text>}
        {tokens.map((token) => (
          <div
            key={token.uuid}
            className="border-border mt-2 flex flex-col gap-2 rounded border border-solid p-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex min-w-0 flex-col">
              <span className="text-base font-medium break-words lg:text-sm">{token.label}</span>
              <span className="text-passive-0 text-sm break-words lg:text-xs">
                Created {formatCalendarValue(token.createdAt)} · Last used {formatCalendarValue(token.lastUsedAt)}
              </span>
            </div>
            <Button className="flex-shrink-0" label="Revoke" onClick={() => void handleDeleteToken(token.uuid)} />
          </div>
        ))}
      </PreferencesSegment>
    </PreferencesGroup>
  )
}

export default observer(CalDavTokens)
