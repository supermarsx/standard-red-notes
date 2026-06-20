import { computeLineDiff, DiffLine } from '@/Components/RevisionHistoryModal/RevisionDiff'

export type AutoMergeResult = {
  /** The merged text. When `clean` is false this contains git-style conflict markers. */
  text: string
  /** True when every change could be merged without an overlapping (conflicting) hunk. */
  clean: boolean
}

const CONFLICT_START = '<<<<<<< This version (local)'
const CONFLICT_MIDDLE = '======='
const CONFLICT_END = '>>>>>>> Other version (remote)'

const splitLines = (text: string): string[] => {
  if (text.length === 0) {
    return []
  }
  return text.replace(/\r\n/g, '\n').split('\n')
}

/**
 * Performs a git-style two-way line merge of `localText` and `remoteText`.
 *
 * We derive a single line diff between the two versions and walk it:
 * - `context` lines are common to both and are emitted as-is.
 * - A run of `removed` lines (only in local) followed/preceded by `added` lines
 *   (only in remote) forms a changed hunk. If the hunk is a pure insertion on one
 *   side (the other side is empty), it is taken automatically (non-overlapping).
 *   If both sides changed the same region (both non-empty), it is an overlapping
 *   conflict and is wrapped in `<<<<<<< / ======= / >>>>>>>` markers.
 *
 * This is intentionally dependency-free and operates on plain diffable text
 * (title + body) produced by the shared RevisionDiff helper.
 */
export const autoMergeText = (localText: string, remoteText: string): AutoMergeResult => {
  const diff: DiffLine[] = computeLineDiff(localText, remoteText)

  const out: string[] = []
  let clean = true
  let index = 0

  while (index < diff.length) {
    const line = diff[index]

    if (line.type === 'context') {
      out.push(line.text)
      index++
      continue
    }

    // Collect a contiguous changed hunk. `removed` => only in local, `added` => only in remote.
    const localLines: string[] = []
    const remoteLines: string[] = []
    while (index < diff.length && diff[index].type !== 'context') {
      if (diff[index].type === 'removed') {
        localLines.push(diff[index].text)
      } else {
        remoteLines.push(diff[index].text)
      }
      index++
    }

    const localChanged = localLines.length > 0
    const remoteChanged = remoteLines.length > 0

    if (localChanged && remoteChanged) {
      // Overlapping change on both sides: emit a conflict block for manual resolution.
      clean = false
      out.push(CONFLICT_START)
      out.push(...localLines)
      out.push(CONFLICT_MIDDLE)
      out.push(...remoteLines)
      out.push(CONFLICT_END)
    } else if (localChanged) {
      // Pure deletion-from-remote / addition-only-in-local: take the local side.
      out.push(...localLines)
    } else if (remoteChanged) {
      // Pure addition-only-in-remote: take the remote side.
      out.push(...remoteLines)
    }
  }

  return { text: out.join('\n'), clean }
}

/**
 * A simple unified two-version concatenation used as a manual-merge starting
 * point. Unlike the auto merge it never tries to reconcile lines; it just lays
 * both versions out with clear separators so the user can hand-edit.
 */
export const buildManualMergeStartingText = (localText: string, remoteText: string): string => {
  const local = splitLines(localText)
  const remote = splitLines(remoteText)
  return [CONFLICT_START, ...local, CONFLICT_MIDDLE, ...remote, CONFLICT_END].join('\n')
}
