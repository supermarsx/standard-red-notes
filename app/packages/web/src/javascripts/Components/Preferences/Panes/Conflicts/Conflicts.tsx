import { FunctionComponent, useCallback, useMemo, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { ConflictResolutionStrategyValue } from '@standardnotes/snjs'
import { ToastType, addToast } from '@standardnotes/toast'

import { WebApplication } from '@/Application/WebApplication'
import { Subtitle, Text, Title } from '@/Components/Preferences/PreferencesComponents/Content'
import PreferencesGroup from '@/Components/Preferences/PreferencesComponents/PreferencesGroup'
import PreferencesPane from '@/Components/Preferences/PreferencesComponents/PreferencesPane'
import PreferencesSegment from '@/Components/Preferences/PreferencesComponents/PreferencesSegment'
import HorizontalSeparator from '@/Components/Shared/HorizontalSeparator'
import Button from '@/Components/Button/Button'
import Switch from '@/Components/Switch/Switch'
import RevisionDiffView from '@/Components/RevisionHistoryModal/RevisionDiffView'
import { getDiffableTextFromContent } from '@/Components/RevisionHistoryModal/RevisionDiff'

import { ConflictPair, useConflicts } from './useConflicts'
import { autoMergeText, buildManualMergeStartingText } from './mergeText'

type Props = {
  application: WebApplication
}

const STRATEGY_OPTIONS: { value: ConflictResolutionStrategyValue; label: string }[] = [
  { value: 'ask', label: 'Ask me (review each conflict)' },
  { value: 'keepBoth', label: 'Keep both copies' },
  { value: 'keepLocal', label: 'Keep this version (local)' },
  { value: 'keepRemote', label: 'Keep the other version (remote)' },
]

/**
 * Splits a diffable text blob (title on the first line, body after) back into a
 * title/text pair so a manual/auto merge can be written onto a note. Mirrors how
 * getDiffableTextFromContent composes the two.
 */
const splitMergedText = (merged: string): { title: string; text: string } => {
  const normalized = merged.replace(/\r\n/g, '\n')
  const newlineIndex = normalized.indexOf('\n')
  if (newlineIndex === -1) {
    return { title: normalized, text: '' }
  }
  return {
    title: normalized.slice(0, newlineIndex),
    text: normalized.slice(newlineIndex + 1),
  }
}

const ConflictRow: FunctionComponent<{
  pair: ConflictPair
  controller: ReturnType<typeof useConflicts>
}> = ({ pair, controller }) => {
  const [busy, setBusy] = useState(false)
  const [mergeText, setMergeText] = useState<string | null>(null)

  const localText = useMemo(() => getDiffableTextFromContent(pair.conflictedCopy.content), [pair])
  const remoteText = useMemo(() => getDiffableTextFromContent(pair.original.content), [pair])

  const run = useCallback(
    async (action: () => Promise<void>, successMessage: string) => {
      setBusy(true)
      try {
        await action()
        addToast({ type: ToastType.Success, message: successMessage })
      } catch (error) {
        console.error(error)
        addToast({ type: ToastType.Error, message: 'Failed to resolve the conflict.' })
      } finally {
        setBusy(false)
      }
    },
    [],
  )

  const openManualMerge = useCallback(() => {
    setMergeText(buildManualMergeStartingText(localText, remoteText))
  }, [localText, remoteText])

  const openAutoMerge = useCallback(() => {
    const result = autoMergeText(localText, remoteText)
    if (result.clean) {
      // No overlapping hunks: save the merge directly.
      const { title, text } = splitMergedText(result.text)
      void run(() => controller.saveMerged(pair, title, text), 'Conflict auto-merged.')
    } else {
      // Overlaps remain: drop the user into the manual editor with markers.
      setMergeText(result.text)
      addToast({
        type: ToastType.Regular,
        message: 'Overlapping changes were found. Edit the marked sections, then save the merge.',
      })
    }
  }, [localText, remoteText, controller, pair, run])

  const saveManualMerge = useCallback(() => {
    if (mergeText === null) {
      return
    }
    const { title, text } = splitMergedText(mergeText)
    void run(() => controller.saveMerged(pair, title, text), 'Merged note saved.').then(() =>
      setMergeText(null),
    )
  }, [mergeText, controller, pair, run])

  return (
    <div className="mt-4 rounded border border-solid border-border p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <Subtitle>{pair.original.title || 'Untitled note'}</Subtitle>
        <span className="rounded bg-danger px-1.5 py-0.5 text-xs font-bold text-danger-contrast">Conflict</span>
      </div>

      <div className="h-64 overflow-hidden rounded border border-border">
        <RevisionDiffView
          oldContent={pair.original.content}
          newContent={pair.conflictedCopy.content}
          oldLabel="Other version (remote / original)"
          newLabel="This version (local / conflicted copy)"
        />
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          disabled={busy}
          label="Keep this version (local)"
          onClick={() => void run(() => controller.keepLocal(pair), 'Kept this version.')}
        />
        <Button
          disabled={busy}
          label="Keep the other version (remote)"
          onClick={() => void run(() => controller.keepRemote(pair), 'Kept the other version.')}
        />
        <Button
          disabled={busy}
          label="Keep both"
          onClick={() => void run(() => controller.keepBoth(pair), 'Kept both copies.')}
        />
        <Button disabled={busy} label="Manual merge" onClick={openManualMerge} />
        <Button disabled={busy} label="Auto merge" onClick={openAutoMerge} />
      </div>

      {mergeText !== null && (
        <div className="mt-3">
          <Text className="mb-1">
            Edit the merged note below. Lines wrapped in <code>{'<<<<<<<'}</code> / <code>=======</code> /{' '}
            <code>{'>>>>>>>'}</code> markers are overlapping changes you should reconcile by hand. The first line
            becomes the note title.
          </Text>
          <textarea
            className="block h-48 w-full rounded border border-solid border-border bg-default px-2 py-1.5 font-mono text-sm text-text"
            value={mergeText}
            onChange={(event) => setMergeText(event.target.value)}
            disabled={busy}
          />
          <div className="mt-2 flex gap-2">
            <Button primary disabled={busy} label="Save merged note" onClick={saveManualMerge} />
            <Button disabled={busy} label="Cancel" onClick={() => setMergeText(null)} />
          </div>
        </div>
      )}
    </div>
  )
}

const Conflicts: FunctionComponent<Props> = ({ application }: Props) => {
  const controller = useConflicts(application)

  return (
    <PreferencesPane>
      <PreferencesGroup>
        <PreferencesSegment>
          <Title>Sync Conflicts</Title>
          <Text>
            When the same note is edited on two devices before they sync, Standard Notes keeps both copies and flags the
            divergent one as a "Conflicted Copy". Review each conflict below: see a git-style diff of the two versions
            and choose how to resolve it.
          </Text>
        </PreferencesSegment>

        <HorizontalSeparator classes="my-4" />

        <PreferencesSegment>
          <Subtitle>Default resolution strategy</Subtitle>
          <Text className="mb-2">
            The client preference below always wins. When it is set to "Ask me", the server-provided default (if any) is
            used; otherwise conflicts are surfaced here for manual review.
            {controller.serverDefaultStrategy
              ? ` Your server's default is "${controller.serverDefaultStrategy}".`
              : ''}
          </Text>

          <label className="block">
            <span className="text-sm font-medium lg:text-xs">Strategy</span>
            <select
              className="mt-1 block w-full rounded border border-solid border-border bg-default px-2 py-1.5 text-base text-text lg:text-sm"
              value={controller.clientStrategy}
              onChange={(event) => controller.setStrategy(event.target.value as ConflictResolutionStrategyValue)}
            >
              {STRATEGY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <div className="mt-3 flex items-center justify-between">
            <div className="mr-4 flex flex-col">
              <Subtitle>Auto-resolve future conflicts</Subtitle>
              <Text>
                When enabled, new conflicts are resolved automatically using the effective strategy above (only applies
                when the strategy is not "Ask me").
              </Text>
            </div>
            <Switch
              checked={controller.autoResolveEnabled}
              onChange={(checked) => controller.setAutoResolveEnabled(checked)}
            />
          </div>
        </PreferencesSegment>

        <HorizontalSeparator classes="my-4" />

        <PreferencesSegment>
          <Subtitle>
            Current conflicts {controller.count > 0 ? `(${controller.count})` : ''}
          </Subtitle>
          {controller.count === 0 ? (
            <Text className="mt-2">You have no unresolved sync conflicts.</Text>
          ) : (
            controller.pairs.map((pair) => <ConflictRow key={pair.id} pair={pair} controller={controller} />)
          )}
        </PreferencesSegment>
      </PreferencesGroup>
    </PreferencesPane>
  )
}

export default observer(Conflicts)
