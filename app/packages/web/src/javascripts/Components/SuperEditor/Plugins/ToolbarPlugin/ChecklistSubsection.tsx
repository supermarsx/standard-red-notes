import { FunctionComponent } from 'react'
import {
  CHECKLIST_GENERATE_CAP_MAX,
  CHECKLIST_GENERATE_CAP_MIN,
  normalizeChecklistGenerateCap,
} from '../../Checklist/checklistBackfill'
import type { ChecklistGenerationResult } from '../../Checklist/checklistGeneration'

export type ChecklistSubsectionProps = {
  /** "Completed tasks move out of the way" (device-local, not synced). */
  autoMoveCompleted: boolean
  onToggleAutoMoveCompleted: () => void
  /** Un-tick every row of the checklist the caret is in. */
  onRestoreCompleted: () => void
  /** False when the selection touches no checklist row; the bulk actions need one. */
  hasChecklistSelection: boolean
  onCompleteAll: () => void
  onCompleteSelected: () => void
  onUncompleteSelected: () => void
  /** Synced: write down missed occurrences of an overdue recurring task. */
  autoGenerate: boolean
  onAutoGenerateChange: (next: boolean) => void
  /** Synced: most occurrences one pass may materialize. Already clamped by the caller. */
  generateCap: number
  onGenerateCapChange: (next: number) => void
  onGenerateNow: () => void
  /**
   * What the last explicit "Generate now" did, or null before one has run in this
   * note. Null renders NO result line at all — "not run yet" must never be drawn
   * as a measured zero.
   */
  lastGeneration: ChecklistGenerationResult | null
}

/**
 * The "Checklists" bordered subsection card: every checklist-wide control in one
 * place instead of three bare toolbar buttons whose scope you had to guess.
 *
 * Kept as its own small, pure, jest-mountable component on the
 * `NavigationLayoutSubsection` model (and for the same reason): the full
 * ToolbarPlugin closes over deep editor state, so a card rendered as inline JSX
 * inside it is far harder to exercise directly. State arrives as props and every
 * action leaves as a callback — nothing here reads the editor, the application or
 * a preference store.
 *
 * It hosts the device-local "move completed out of the way" toggle, restore, the
 * three bulk-completion actions, and the two synced recurrence-generation
 * settings plus an explicit "Generate now".
 */
export const ChecklistSubsection: FunctionComponent<ChecklistSubsectionProps> = ({
  autoMoveCompleted,
  onToggleAutoMoveCompleted,
  onRestoreCompleted,
  hasChecklistSelection,
  onCompleteAll,
  onCompleteSelected,
  onUncompleteSelected,
  autoGenerate,
  onAutoGenerateChange,
  generateCap,
  onGenerateCapChange,
  onGenerateNow,
  lastGeneration,
}) => {
  const actionClassName =
    'border-border bg-default hover:bg-contrast focus:border-info rounded-md border px-2 py-1 text-xs disabled:cursor-default disabled:opacity-50 disabled:hover:bg-default'

  return (
    <div className="border-border rounded-md border p-3" data-super-toolbar-checklist-subsection="">
      <div className="text-sm font-medium">Checklists</div>

      <label className="mt-2 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={autoMoveCompleted} onChange={onToggleAutoMoveCompleted} />
        Move completed tasks out of the way
      </label>
      <p className="text-passive-1 mt-1 text-xs">
        A ticked row sinks below the ones still open, in the checklist it belongs to.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" className={actionClassName} onClick={onRestoreCompleted}>
          Restore completed
        </button>
        <button type="button" className={actionClassName} onClick={onCompleteAll} disabled={!hasChecklistSelection}>
          Complete all
        </button>
        <button
          type="button"
          className={actionClassName}
          onClick={onCompleteSelected}
          disabled={!hasChecklistSelection}
        >
          Complete selected
        </button>
        <button
          type="button"
          className={actionClassName}
          onClick={onUncompleteSelected}
          disabled={!hasChecklistSelection}
        >
          Uncomplete selected
        </button>
      </div>
      <p className="text-passive-1 mt-1 text-xs">
        {hasChecklistSelection
          ? 'These act on the checklist your selection is in, not the whole note.'
          : 'Put the caret in a checklist to enable the completion actions. Restore also needs one.'}
      </p>

      <div className="border-border mt-3 rounded-md border p-3">
        <div className="text-sm font-medium">Recurring tasks</div>

        <label className="mt-2 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={autoGenerate}
            onChange={(event) => onAutoGenerateChange(event.target.checked)}
          />
          Write down missed occurrences
        </label>
        <p className="text-passive-1 mt-1 text-xs">
          A recurring task completed late, or never completed, otherwise skips straight to its next occurrence and the
          ones it owed disappear. With this on, each owed occurrence becomes a plain dated task beneath it.
        </p>

        <div className="mt-2 flex items-center justify-between gap-2">
          <label className="text-passive-1 text-xs" htmlFor="checklist-generate-cap">
            At most, per pass
          </label>
          <input
            id="checklist-generate-cap"
            type="number"
            min={CHECKLIST_GENERATE_CAP_MIN}
            max={CHECKLIST_GENERATE_CAP_MAX}
            aria-label="Most occurrences to generate at once"
            value={generateCap}
            onChange={(event) => {
              const parsed = parseInt(event.target.value, 10)
              if (!Number.isNaN(parsed)) {
                onGenerateCapChange(normalizeChecklistGenerateCap(parsed))
              }
            }}
            className="border-border bg-default focus:border-info h-8 w-20 rounded-md border px-2 text-sm focus:outline-none"
          />
        </div>
        <p className="text-passive-1 mt-1 text-xs">
          Older occurrences past this many are not dropped silently — they are recorded as one summary task saying how
          many were missed and when.
        </p>

        <div className="mt-2 flex items-center gap-2">
          <button type="button" className={actionClassName} onClick={onGenerateNow}>
            Generate now
          </button>
          <span className="text-passive-1 text-xs">Runs over this note, even with the setting above off.</span>
        </div>
        {lastGeneration !== null && (
          <p className="mt-1 text-xs" data-super-toolbar-checklist-generation-result="">
            {lastGeneration.generated === 0 && lastGeneration.summaries === 0 && lastGeneration.advanced === 0
              ? `Nothing was owed. Looked at ${lastGeneration.examined} recurring ${
                  lastGeneration.examined === 1 ? 'task' : 'tasks'
                }.`
              : `Generated ${lastGeneration.generated} ${
                  lastGeneration.generated === 1 ? 'occurrence' : 'occurrences'
                } across ${lastGeneration.tasks} ${lastGeneration.tasks === 1 ? 'task' : 'tasks'}` +
                (lastGeneration.summaries > 0
                  ? `, plus ${lastGeneration.summaries} ${
                      lastGeneration.summaries === 1 ? 'summary' : 'summaries'
                    } for what the cap left out`
                  : '') +
                '.'}
          </p>
        )}

        <p className="text-passive-1 mt-2 text-xs">
          Subtasks of a generated occurrence are <strong className="font-semibold">not</strong> reproduced: only the
          live task keeps its subtree, exactly as completing it by hand does.
        </p>
        <p className="text-passive-1 mt-1 text-xs">
          A month-end deadline keeps its own day — Jan 31 becomes Feb 28, then Mar 31 — but that intent is not passed
          down: a subtask that takes up its parent&apos;s cadence stays anchored on its own date.
        </p>
      </div>
    </div>
  )
}
