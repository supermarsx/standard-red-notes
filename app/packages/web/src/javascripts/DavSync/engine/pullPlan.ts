import { isInboundId } from '../identity'
import { DavEntryRecord } from '../state/noteState'

/**
 * Standard Red Notes: what one read-only pass does to a linked note.
 *
 * A pure function. It is given what the note holds, what the note remembers,
 * and what the server's listing and the fetched entries say, and it returns the
 * changes to make. It reads no clock and makes no request, so every rule below
 * can be tested over thousands of generated cases, and the same inputs give the
 * same plan on every device.
 *
 * The rules, for a link that only brings entries in:
 *
 *  - An entry the server lists is in the note as the server has it. If the
 *    note's copy differs from what was agreed (an older build stripped it, a
 *    person edited a read-only calendar) the server's version is put back.
 *  - An entry the note remembers that the server no longer lists is removed
 *    from the note. For a read-only import, "deleted there" and "moved out of
 *    the window" both mean it is no longer shown here.
 *  - An entry that could not be read is listed as such and its copy in the
 *    note, if there is one, is left exactly as it is.
 *  - Events in the note that did not come from the server are never touched.
 *  - Nothing is ever removed because something could not be found out. Only a
 *    listing that arrived can remove; the caller does not plan without one.
 */

export type RemoteEntry =
  /** In the listing with the ETag already seen, and not fetched. */
  | { name: string; state: 'unchanged' }
  /** Fetched and read. `id` is the id computed from its UID. */
  | { name: string; state: 'fetched'; id: string; fingerprint: string }
  /** In the listing, but its content could not be fetched or read. */
  | { name: string; state: 'unreadable'; reason: string }

export type PullPlanInput = {
  /** Fingerprint of each event in the note, by event id. */
  local: ReadonlyMap<string, string>
  /** What the note remembers, by event id. */
  records: Readonly<Record<string, DavEntryRecord>>
  /** Every entry of the listing, once. */
  remote: readonly RemoteEntry[]
}

export type PullPlan = {
  /** Entries whose server version goes into the note, replacing any copy with that id. */
  write: { id: string; name: string; fingerprint: string }[]
  /** Event ids to take out of the note. */
  remove: string[]
  /** The records the note holds afterwards. */
  records: Record<string, DavEntryRecord>
  /** Entries that could not be read, by name, with the reason. */
  unreadable: Record<string, string>
  counts: { added: number; changed: number; removed: number; unchanged: number; unreadable: number }
}

const byName = (a: { name: string }, b: { name: string }): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

export function planPull(input: PullPlanInput): PullPlan {
  const plan: PullPlan = {
    write: [],
    remove: [],
    records: {},
    unreadable: {},
    counts: { added: 0, changed: 0, removed: 0, unchanged: 0, unreadable: 0 },
  }
  const idOfName = new Map<string, string>()
  for (const id of Object.keys(input.records)) {
    idOfName.set(input.records[id].h, id)
  }
  /** Event ids that stay in the note after this pass. */
  const kept = new Set<string>()
  let unidentified = 0

  // In name order, so that when two entries claim one UID the same one wins on every device.
  for (const entry of [...input.remote].sort(byName)) {
    if (entry.state === 'unreadable') {
      plan.unreadable[entry.name] = entry.reason
      plan.counts.unreadable += 1
      // Whatever the note holds for it stays, record and all: unread is not gone.
      const id = idOfName.get(entry.name)
      if (id !== undefined && !kept.has(id)) {
        kept.add(id)
        plan.records[id] = input.records[id]
      } else if (id === undefined) {
        // No record says which event this is, so it might be any the note holds without one.
        unidentified += 1
      }
      continue
    }

    if (entry.state === 'unchanged') {
      const id = idOfName.get(entry.name)
      if (id === undefined || kept.has(id)) {
        // Listed, but nothing is known about it: not fetched, and no record says which event it is.
        // It is fetched on the next pass. Until then it might be any event the note holds.
        unidentified += 1
        continue
      }
      kept.add(id)
      plan.records[id] = input.records[id]
      plan.counts.unchanged += 1
      continue
    }

    if (kept.has(entry.id)) {
      // A second entry with the UID of one already placed. A calendar must not hold two; this one is not shown.
      plan.unreadable[entry.name] = 'duplicate-uid'
      plan.counts.unreadable += 1
      continue
    }
    kept.add(entry.id)
    plan.records[entry.id] = { h: entry.name, b: entry.fingerprint }
    const held = input.local.get(entry.id)
    if (held === entry.fingerprint) {
      plan.counts.unchanged += 1
    } else {
      plan.write.push({ id: entry.id, name: entry.name, fingerprint: entry.fingerprint })
      plan.counts[held === undefined ? 'added' : 'changed'] += 1
    }
  }

  // What the note holds from the server that the server no longer lists: entries it remembers by
  // name, and entries that carry a server id with no record left. The second kind can only be told
  // from "listed but not yet identified" when every listed entry was identified, so while one is
  // not, they stay.
  const fromServer = new Set<string>(Object.keys(input.records))
  if (unidentified === 0) {
    for (const id of input.local.keys()) {
      if (isInboundId(id)) {
        fromServer.add(id)
      }
    }
  }
  for (const id of [...fromServer].sort()) {
    if (!kept.has(id) && input.local.has(id)) {
      plan.remove.push(id)
      plan.counts.removed += 1
    }
  }
  return plan
}

/**
 * Why a plan must not be carried out without asking, or undefined when it may.
 *
 * A pass that would take a large part of a calendar out of the note is far more
 * often a server that answered wrongly than a person who deleted that much, so
 * it stops and says what it would do.
 */
export type Brake = { kind: 'empty-listing' | 'many-removals'; removals: number; held: number }

export const BRAKE_MIN_REMOVALS = 5
export const BRAKE_REMOVAL_SHARE = 0.1

export function brakeFor(plan: PullPlan, input: PullPlanInput): Brake | undefined {
  const held = Object.keys(input.records).filter((id) => input.local.has(id)).length
  const removals = plan.remove.length
  if (removals > BRAKE_MIN_REMOVALS && input.remote.length === 0) {
    return { kind: 'empty-listing', removals, held }
  }
  if (removals > Math.max(BRAKE_MIN_REMOVALS, Math.floor(held * BRAKE_REMOVAL_SHARE))) {
    return { kind: 'many-removals', removals, held }
  }
  return undefined
}
