import { FunctionComponent, useCallback, useEffect, useMemo, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { isErrorResponse, PrefKey, SNNote } from '@standardnotes/snjs'
import { ToastType, addToast } from '@standardnotes/toast'

import { WebApplication } from '@/Application/WebApplication'
import Button from '@/Components/Button/Button'
import DecoratedInput from '@/Components/Input/DecoratedInput'
import { Subtitle, Text } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Switch from '@/Components/Switch/Switch'
import { collectAllTodos } from '@/Components/TodoAggregate/allTodos'
import {
  DEFAULT_TODO_CALENDAR_PUBLICATION,
  normalizeTodoCalendarPublication,
  staleTodoCalendarUids,
  TODO_CALENDAR_MAX_ITEMS,
  TODO_CALENDAR_PUBLICATION_PREF_KEY,
  todoCalendarPublications,
  type TodoCalendarPublicationSettings,
  type TodoCalendarScopeMode,
} from '@/Components/TodoAggregate/todoCalendarPublication'
import {
  collectTodoTagOptions,
  todoRowsFromGroups,
  todoTagLabel,
  type TodoTag,
} from '@/Components/TodoAggregate/todoFilters'

/**
 * Standard Red Notes: the preferences surface for "show task due dates in my
 * calendar as events".
 *
 * There are TWO halves, and they are deliberately presented as two, because
 * they do different things and fail differently:
 *
 *  - **Scope** (this device's synced pref) decides WHICH deadlines leave
 *    end-to-end encryption at all. Narrow by default.
 *  - **Event shape** (per-user settings stored on the server) decides what the
 *    calendar DRAWS. Changing it re-renders records already published, so a
 *    client re-polls and sees the change without anything being republished.
 *
 * Both are shown read-only until CalDAV is enabled on the server AND for this
 * account, so a user can see what they have configured and why it is inactive.
 */

type Props = {
  application: WebApplication
  /** Both CalDAV gates are open, so writes are accepted. */
  canWrite: boolean
  /** A publish or unpublish happened and the parent's list should reload. */
  onPublished: () => void
}

/** Mirrors the gateway's `CalendarProjectionSettings`. */
type ProjectionSettings = {
  enabled: boolean
  allDay: 'auto' | 'always' | 'never'
  durationMinutes: number
  anchor: 'start' | 'end'
  timeZone: string
  completed: 'hide' | 'show' | 'mark'
  alarm: 'none' | 'at-time' | 'lead'
  alarmLeadMinutes: number
  recurrence: 'ignore' | 'rrule' | 'first-only'
  summaryPrefix: string
}

const DEFAULT_PROJECTION: ProjectionSettings = {
  enabled: false,
  allDay: 'auto',
  durationMinutes: 60,
  anchor: 'end',
  timeZone: '',
  completed: 'hide',
  alarm: 'none',
  alarmLeadMinutes: 15,
  recurrence: 'rrule',
  summaryPrefix: '',
}

// See `todoCalendarPublication.ts`: the literal is pinned because web resolves
// PrefKey's runtime value from a generated bundle that predates a new member.
const PUBLICATION_PREF = TODO_CALENDAR_PUBLICATION_PREF_KEY as unknown as PrefKey

const SCOPE_LABEL: Record<TodoCalendarScopeMode, string> = {
  all: 'Every task with a due date',
  tags: 'Only tasks in selected folders',
  notes: 'Only tasks in selected notes',
}

const selectClasses =
  'rounded border border-border bg-default px-2 py-1.5 text-sm text-foreground focus:border-info focus:outline-none'

const CalDavDueDateEvents: FunctionComponent<Props> = ({ application, canWrite, onPublished }: Props) => {
  const [projection, setProjection] = useState<ProjectionSettings>(DEFAULT_PROJECTION)
  const [publication, setPublication] = useState<TodoCalendarPublicationSettings>(() =>
    normalizeTodoCalendarPublication(undefined),
  )
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [loadError, setLoadError] = useState(false)

  const loadProjection = useCallback(async () => {
    try {
      const response = await application.legacyApi.getCaldavProjection()
      if (isErrorResponse(response)) {
        setLoadError(true)
        return
      }
      const data = (response as { data?: { projection?: Partial<ProjectionSettings> } }).data
      // Merge onto the defaults rather than replacing: a server one field behind
      // must not blank the controls it did not send.
      setProjection({ ...DEFAULT_PROJECTION, ...(data?.projection ?? {}) })
      setLoadError(false)
    } catch (error) {
      console.error(error)
      setLoadError(true)
    }
  }, [application])

  useEffect(() => {
    void loadProjection()
  }, [loadProjection])

  useEffect(() => {
    setPublication(
      normalizeTodoCalendarPublication(
        application.getPreference(PUBLICATION_PREF, DEFAULT_TODO_CALENDAR_PUBLICATION as never),
      ),
    )
  }, [application])

  const notes = useMemo(() => application.items.getDisplayableNotes(), [application])

  /**
   * The same tag shape the Todos view builds: `longTitle` is the full ancestor
   * path, without which two folders both named "Personal" under different
   * parents are indistinguishable in the scope list — the exact case nesting
   * exists for.
   */
  const tagsForNote = useCallback(
    (note: SNNote): TodoTag[] =>
      application.items.getSortedTagsForItem(note).map((tag) => ({
        uuid: tag.uuid,
        title: tag.title,
        longTitle: application.items.getTagLongTitle(tag),
      })),
    [application],
  )

  const tagOptions = useMemo<TodoTag[]>(() => {
    const groups = collectAllTodos(notes as SNNote[])
    const rows = todoRowsFromGroups(groups, tagsForNote)
    return collectTodoTagOptions(rows)
  }, [notes, tagsForNote])

  const saveProjection = useCallback(
    async (next: ProjectionSettings) => {
      setProjection(next)
      setSaving(true)
      try {
        const response = await application.legacyApi.putCaldavProjection(next as unknown as Record<string, unknown>)
        if (isErrorResponse(response)) {
          const data = response.data as { error?: { message?: string } } | undefined
          addToast({
            type: ToastType.Error,
            message: data?.error?.message ?? 'Failed to save the calendar event settings.',
          })
          await loadProjection()
          return
        }
        const stored = (response as { data?: { projection?: Partial<ProjectionSettings> } }).data?.projection
        // Echo the EFFECTIVE values: a clamped duration or a rejected time zone
        // must be visible immediately rather than looking saved.
        setProjection({ ...DEFAULT_PROJECTION, ...(stored ?? {}) })
      } catch (error) {
        console.error(error)
        addToast({ type: ToastType.Error, message: 'Failed to save the calendar event settings.' })
        await loadProjection()
      } finally {
        setSaving(false)
      }
    },
    [application, loadProjection],
  )

  const savePublication = useCallback(
    async (next: TodoCalendarPublicationSettings) => {
      const normalized = normalizeTodoCalendarPublication(next)
      setPublication(normalized)
      try {
        await application.setPreference(PUBLICATION_PREF, { version: 1, ...normalized } as never)
      } catch (error) {
        console.error(error)
        addToast({ type: ToastType.Error, message: 'Failed to save the task scope.' })
      }
    },
    [application],
  )

  const handleSync = useCallback(async () => {
    setPublishing(true)
    try {
      const groups = collectAllTodos(notes as SNNote[])
      const rows = todoRowsFromGroups(groups, tagsForNote)
      const publications = todoCalendarPublications(rows, publication)

      const existing = await application.legacyApi.listCaldavTodos()
      const publishedUids = isErrorResponse(existing)
        ? []
        : (((existing as { data?: { todos?: { uid: string }[] } }).data?.todos ?? []).map(
            (todo) => todo.uid,
          ) as string[])

      let published = 0
      for (const item of publications) {
        const response = await application.legacyApi.publishCaldavTodo(item)
        if (isErrorResponse(response)) {
          const data = response.data as { error?: { message?: string } } | undefined
          addToast({
            type: ToastType.Error,
            message: data?.error?.message ?? `Failed to publish "${item.summary}".`,
          })
          return
        }
        published += 1
      }

      // Anything this pass no longer owns is removed, so narrowing the scope or
      // finishing a task actually takes the event OFF the calendar instead of
      // leaving a stale copy behind.
      const stale = staleTodoCalendarUids(publishedUids, publications)
      let removed = 0
      for (const uid of stale) {
        const response = await application.legacyApi.deleteCaldavTodo(uid)
        if (!isErrorResponse(response)) {
          removed += 1
        }
      }

      onPublished()
      addToast({
        type: ToastType.Success,
        message: `Published ${published} due date${published === 1 ? '' : 's'}; removed ${removed}.`,
      })
    } catch (error) {
      console.error(error)
      addToast({ type: ToastType.Error, message: 'Failed to publish task due dates.' })
    } finally {
      setPublishing(false)
    }
  }, [application, notes, onPublished, publication, tagsForNote])

  const toggleScopeId = useCallback(
    (key: 'tagUuids' | 'noteUuids', uuid: string) => {
      const current = publication[key]
      const next = current.includes(uuid) ? current.filter((entry) => entry !== uuid) : [...current, uuid]
      void savePublication({ ...publication, [key]: next })
    },
    [publication, savePublication],
  )

  const disabled = !canWrite || saving

  return (
    <>
      <HorizontalSeparator classes="my-4" />
      <PreferencesSegment>
        <Subtitle>Show task due dates as calendar events</Subtitle>
        <Text className="mb-2">
          Published tasks are also served as a separate <em>Task Due Dates</em> calendar of ordinary events, so they
          appear on the calendar grid in apps that do not draw to-dos at all. The to-do calendar is unchanged.
        </Text>
        {loadError && (
          <div className="border-warning bg-warning-faded mt-2 rounded border border-solid p-3">
            <Text>
              The calendar event settings could not be loaded, so the values below are defaults and may not match the
              server. Retry before changing them.
            </Text>
            <Button className="mt-2" label="Retry" onClick={() => void loadProjection()} />
          </div>
        )}

        <div className="mt-3 flex items-center justify-between">
          <div className="flex flex-col">
            <Subtitle>Due dates appear as events</Subtitle>
            <Text>
              Off by default. While off, the event calendar does not exist at all — a calendar app that still has the
              URL subscribed stops drawing these events rather than keeping a stale copy.
            </Text>
          </div>
          <Switch
            disabled={disabled}
            checked={projection.enabled}
            onChange={() => void saveProjection({ ...projection, enabled: !projection.enabled })}
          />
        </div>

        <div className="mt-4 flex flex-col gap-3">
          <label className="flex items-center justify-between gap-3">
            <Text>All-day or timed</Text>
            <select
              className={selectClasses}
              disabled={disabled}
              value={projection.allDay}
              onChange={(event) =>
                void saveProjection({ ...projection, allDay: event.target.value as ProjectionSettings['allDay'] })
              }
            >
              <option value="auto">Automatic (midnight means all-day)</option>
              <option value="always">Always all-day</option>
              <option value="never">Always timed</option>
            </select>
          </label>
          <Text className="-mt-2">
            A deadline is stored as a single instant, and leaving the time field blank saves local midnight. Automatic
            treats exactly that midnight — in the time zone below — as &ldquo;a date, with no time&rdquo;.
          </Text>

          <label className="flex items-center justify-between gap-3">
            <Text>Timed events are</Text>
            <select
              className={selectClasses}
              disabled={disabled}
              value={projection.anchor}
              onChange={(event) =>
                void saveProjection({ ...projection, anchor: event.target.value as ProjectionSettings['anchor'] })
              }
            >
              <option value="end">Blocked out before the deadline</option>
              <option value="start">Started at the deadline</option>
            </select>
          </label>

          <label className="flex items-center justify-between gap-3">
            <Text>Timed event length (minutes)</Text>
            <DecoratedInput
              type="number"
              disabled={disabled}
              value={`${projection.durationMinutes}`}
              onChange={(value) =>
                void saveProjection({ ...projection, durationMinutes: Number.parseInt(value, 10) || 60 })
              }
            />
          </label>

          <label className="flex items-center justify-between gap-3">
            <Text>Time zone for dates (blank means UTC)</Text>
            <DecoratedInput
              placeholder="e.g. Europe/Berlin"
              disabled={disabled}
              value={projection.timeZone}
              onChange={(value) => setProjection((current) => ({ ...current, timeZone: value }))}
            />
          </label>
          <Button
            className="self-start"
            disabled={disabled}
            label="Apply time zone"
            onClick={() => void saveProjection(projection)}
          />
          <Text className="-mt-1">
            All-day events are floating, so they stay on the same calendar date wherever you travel. Timed events are
            sent as exact instants in UTC, so a client shows them converted to wherever you are.
          </Text>

          <label className="flex items-center justify-between gap-3">
            <Text>Completed tasks</Text>
            <select
              className={selectClasses}
              disabled={disabled}
              value={projection.completed}
              onChange={(event) =>
                void saveProjection({
                  ...projection,
                  completed: event.target.value as ProjectionSettings['completed'],
                })
              }
            >
              <option value="hide">Hidden</option>
              <option value="show">Shown as normal events</option>
              <option value="mark">Shown as cancelled (struck through)</option>
            </select>
          </label>

          <label className="flex items-center justify-between gap-3">
            <Text>Reminder alarm</Text>
            <select
              className={selectClasses}
              disabled={disabled}
              value={projection.alarm}
              onChange={(event) =>
                void saveProjection({ ...projection, alarm: event.target.value as ProjectionSettings['alarm'] })
              }
            >
              <option value="none">None</option>
              <option value="at-time">At the deadline</option>
              <option value="lead">Before the deadline</option>
            </select>
          </label>
          {projection.alarm === 'lead' && (
            <label className="flex items-center justify-between gap-3">
              <Text>Alarm lead time (minutes)</Text>
              <DecoratedInput
                type="number"
                disabled={disabled}
                value={`${projection.alarmLeadMinutes}`}
                onChange={(value) =>
                  void saveProjection({ ...projection, alarmLeadMinutes: Number.parseInt(value, 10) || 0 })
                }
              />
            </label>
          )}

          <label className="flex items-center justify-between gap-3">
            <Text>Repeating tasks</Text>
            <select
              className={selectClasses}
              disabled={disabled}
              value={projection.recurrence}
              onChange={(event) =>
                void saveProjection({
                  ...projection,
                  recurrence: event.target.value as ProjectionSettings['recurrence'],
                })
              }
            >
              <option value="rrule">One repeating event</option>
              <option value="first-only">Only the next occurrence</option>
              <option value="ignore">Not shown at all</option>
            </select>
          </label>
          <Text className="-mt-2">
            A repeating event is exact for daily, weekday and weekly rules. A timed repeat in a zone with daylight
            saving shifts by the offset for part of the year, because the event carries an exact instant while the task
            carries a wall-clock time; choose &ldquo;only the next occurrence&rdquo; if that matters.
          </Text>

          <label className="flex items-center justify-between gap-3">
            <Text>Title prefix</Text>
            <DecoratedInput
              placeholder="e.g. Due:"
              disabled={disabled}
              value={projection.summaryPrefix}
              onChange={(value) => setProjection((current) => ({ ...current, summaryPrefix: value }))}
            />
          </label>
          <Button
            className="self-start"
            disabled={disabled}
            label="Apply title prefix"
            onClick={() => void saveProjection(projection)}
          />
        </div>
      </PreferencesSegment>

      <HorizontalSeparator classes="my-4" />
      <PreferencesSegment>
        <Subtitle>Which task due dates are published</Subtitle>
        <Text className="mb-2">
          This chooses what leaves end-to-end encryption. Nothing is published until you run it, and a task that falls
          out of scope is removed from the calendar on the next run.
        </Text>

        <label className="mt-2 flex items-center justify-between gap-3">
          <Text>Scope</Text>
          <select
            className={selectClasses}
            disabled={!canWrite}
            value={publication.scope}
            onChange={(event) =>
              void savePublication({ ...publication, scope: event.target.value as TodoCalendarScopeMode })
            }
          >
            {(['tags', 'notes', 'all'] as TodoCalendarScopeMode[]).map((mode) => (
              <option key={mode} value={mode}>
                {SCOPE_LABEL[mode]}
              </option>
            ))}
          </select>
        </label>

        {publication.scope === 'tags' && (
          <div className="mt-3 flex flex-col gap-1">
            {tagOptions.length === 0 ? (
              <Text>None of your tasks are in a folder yet, so this scope publishes nothing.</Text>
            ) : (
              tagOptions.map((tag) => (
                <label key={tag.uuid} className="flex items-center justify-between gap-3">
                  <Text>{todoTagLabel(tag)}</Text>
                  <Switch
                    disabled={!canWrite}
                    checked={publication.tagUuids.includes(tag.uuid)}
                    onChange={() => toggleScopeId('tagUuids', tag.uuid)}
                  />
                </label>
              ))
            )}
          </div>
        )}

        {publication.scope === 'notes' && (
          <div className="mt-3 flex flex-col gap-1">
            {collectAllTodos(notes as SNNote[]).length === 0 ? (
              <Text>No note contains a checklist yet, so this scope publishes nothing.</Text>
            ) : (
              collectAllTodos(notes as SNNote[]).map((group) => (
                <label key={group.note.uuid} className="flex items-center justify-between gap-3">
                  <Text>{group.note.title?.trim() || 'Untitled'}</Text>
                  <Switch
                    disabled={!canWrite}
                    checked={publication.noteUuids.includes(group.note.uuid)}
                    onChange={() => toggleScopeId('noteUuids', group.note.uuid)}
                  />
                </label>
              ))
            )}
          </div>
        )}

        <div className="mt-3 flex items-center justify-between">
          <Text>Include completed tasks</Text>
          <Switch
            disabled={!canWrite}
            checked={publication.includeCompleted}
            onChange={() => void savePublication({ ...publication, includeCompleted: !publication.includeCompleted })}
          />
        </div>
        <div className="mt-2 flex items-center justify-between">
          <Text>Treat a deadline at local midnight as a date with no time</Text>
          <Switch
            disabled={!canWrite}
            checked={publication.dateOnlyAtLocalMidnight}
            onChange={() =>
              void savePublication({ ...publication, dateOnlyAtLocalMidnight: !publication.dateOnlyAtLocalMidnight })
            }
          />
        </div>
        <div className="mt-2 flex items-center justify-between">
          <Text>Attach folder names as calendar categories</Text>
          <Switch
            disabled={!canWrite}
            checked={publication.includeTagsAsCategories}
            onChange={() =>
              void savePublication({ ...publication, includeTagsAsCategories: !publication.includeTagsAsCategories })
            }
          />
        </div>
        <label className="mt-2 flex items-center justify-between gap-3">
          <Text>Maximum tasks per run (1 to {TODO_CALENDAR_MAX_ITEMS})</Text>
          <DecoratedInput
            type="number"
            disabled={!canWrite}
            value={`${publication.maximumItems}`}
            onChange={(value) =>
              void savePublication({ ...publication, maximumItems: Number.parseInt(value, 10) || 1 })
            }
          />
        </label>

        <Button
          className="mt-3"
          primary
          disabled={!canWrite || publishing}
          label={publishing ? 'Publishing…' : 'Publish task due dates now'}
          onClick={() => void handleSync()}
        />
      </PreferencesSegment>
    </>
  )
}

export default observer(CalDavDueDateEvents)
