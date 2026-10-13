/**
 * @jest-environment node
 */
import { localIdForUid } from '../identity'
import { DavEntryRecord } from '../state/noteState'
import { BRAKE_MIN_REMOVALS, PullPlanInput, RemoteEntry, brakeFor, planPull } from './pullPlan'

const id = (uid: string): string => localIdForUid(uid)
const fetched = (name: string, uid: string, fingerprint: string): RemoteEntry => ({
  name,
  state: 'fetched',
  id: id(uid),
  fingerprint,
})
const input = (
  local: [string, string][],
  records: Record<string, DavEntryRecord>,
  remote: RemoteEntry[],
): PullPlanInput => ({ local: new Map(local), records, remote })

describe('planPull', () => {
  it('brings in an entry the note does not hold', () => {
    const plan = planPull(input([], {}, [fetched('a.ics', 'a', 'A1')]))
    expect(plan.write).toEqual([{ id: id('a'), name: 'a.ics', fingerprint: 'A1' }])
    expect(plan.remove).toEqual([])
    expect(plan.records).toEqual({ [id('a')]: { h: 'a.ics', b: 'A1' } })
    expect(plan.counts).toEqual({ added: 1, changed: 0, removed: 0, unchanged: 0, unreadable: 0 })
  })

  it('does nothing for an entry both sides still hold as agreed', () => {
    const records = { [id('a')]: { h: 'a.ics', b: 'A1' } }
    const whenFetched = planPull(input([[id('a'), 'A1']], records, [fetched('a.ics', 'a', 'A1')]))
    const whenOnlyListed = planPull(input([[id('a'), 'A1']], records, [{ name: 'a.ics', state: 'unchanged' }]))
    for (const plan of [whenFetched, whenOnlyListed]) {
      expect(plan.write).toEqual([])
      expect(plan.remove).toEqual([])
      expect(plan.records).toEqual(records)
      expect(plan.counts).toEqual({ added: 0, changed: 0, removed: 0, unchanged: 1, unreadable: 0 })
    }
  })

  it('takes the server’s version of an entry that changed there', () => {
    const plan = planPull(
      input([[id('a'), 'A1']], { [id('a')]: { h: 'a.ics', b: 'A1' } }, [fetched('a.ics', 'a', 'A2')]),
    )
    expect(plan.write).toEqual([{ id: id('a'), name: 'a.ics', fingerprint: 'A2' }])
    expect(plan.records[id('a')]).toEqual({ h: 'a.ics', b: 'A2' })
    expect(plan.counts.changed).toBe(1)
  })

  it('puts the server’s version back over a copy that was changed in the note', () => {
    // A read-only import: whatever happened to the note's copy (an older build stripped it, say),
    // the server's is the one that is shown.
    const plan = planPull(
      input([[id('a'), 'stripped']], { [id('a')]: { h: 'a.ics', b: 'A1' } }, [fetched('a.ics', 'a', 'A1')]),
    )
    expect(plan.write).toEqual([{ id: id('a'), name: 'a.ics', fingerprint: 'A1' }])
    expect(plan.remove).toEqual([])
    expect(plan.counts.changed).toBe(1)
  })

  it('brings an entry in again that is missing from the note without having been deleted', () => {
    const plan = planPull(input([], { [id('a')]: { h: 'a.ics', b: 'A1' } }, [fetched('a.ics', 'a', 'A1')]))
    expect(plan.write).toEqual([{ id: id('a'), name: 'a.ics', fingerprint: 'A1' }])
    expect(plan.counts.added).toBe(1)
  })

  it('remembers an entry it finds already in the note as the server has it, without writing it again', () => {
    // The records were lost; the events were not. Identity is computed, so nothing is duplicated.
    const plan = planPull(input([[id('a'), 'A1']], {}, [fetched('a.ics', 'a', 'A1')]))
    expect(plan.write).toEqual([])
    expect(plan.remove).toEqual([])
    expect(plan.records).toEqual({ [id('a')]: { h: 'a.ics', b: 'A1' } })
  })

  it('removes from the note an entry the server no longer lists', () => {
    const records = { [id('a')]: { h: 'a.ics', b: 'A1' }, [id('b')]: { h: 'b.ics', b: 'B1' } }
    const plan = planPull(
      input(
        [
          [id('a'), 'A1'],
          [id('b'), 'B1'],
        ],
        records,
        [{ name: 'a.ics', state: 'unchanged' }],
      ),
    )
    expect(plan.remove).toEqual([id('b')])
    expect(plan.records).toEqual({ [id('a')]: { h: 'a.ics', b: 'A1' } })
    expect(plan.counts).toEqual({ added: 0, changed: 0, removed: 1, unchanged: 1, unreadable: 0 })
  })

  it('removes a server entry left in the note with no record, once every listed entry is identified', () => {
    const plan = planPull(input([[id('gone'), 'G']], {}, [fetched('a.ics', 'a', 'A1')]))
    expect(plan.remove).toEqual([id('gone')])
  })

  it('does not remove it while a listed entry has not been identified, since it may be that one', () => {
    const plan = planPull(input([[id('maybe'), 'M']], {}, [{ name: 'unknown.ics', state: 'unchanged' }]))
    expect(plan.remove).toEqual([])
    expect(plan.write).toEqual([])
  })

  it('does not remove it while a listed entry could not be read and has no record, for the same reason', () => {
    const plan = planPull(
      input([[id('maybe'), 'M']], {}, [{ name: 'odd.ics', state: 'unreadable', reason: 'no-usable-start' }]),
    )
    expect(plan.remove).toEqual([])
    expect(plan.unreadable).toEqual({ 'odd.ics': 'no-usable-start' })
  })

  it('never touches an event that did not come from the server', () => {
    const plan = planPull(
      input(
        [
          ['evt-made-in-the-app', 'X'],
          [id('a'), 'A1'],
        ],
        { [id('a')]: { h: 'a.ics', b: 'A1' } },
        [],
      ),
    )
    expect(plan.remove).toEqual([id('a')])
    expect(plan.write).toEqual([])
  })

  it('leaves the note’s copy of an entry that could not be read exactly as it is', () => {
    const records = { [id('a')]: { h: 'a.ics', b: 'A1' } }
    const plan = planPull(
      input([[id('a'), 'changed-here']], records, [{ name: 'a.ics', state: 'unreadable', reason: 'no-usable-start' }]),
    )
    expect(plan.write).toEqual([])
    expect(plan.remove).toEqual([])
    expect(plan.records).toEqual(records)
    expect(plan.unreadable).toEqual({ 'a.ics': 'no-usable-start' })
    expect(plan.counts.unreadable).toBe(1)
  })

  it('lists an unreadable entry the note has never held, and brings nothing in for it', () => {
    const plan = planPull(input([], {}, [{ name: 'odd.ics', state: 'unreadable', reason: 'not-calendar-data' }]))
    expect(plan.unreadable).toEqual({ 'odd.ics': 'not-calendar-data' })
    expect(plan.write).toEqual([])
    expect(plan.records).toEqual({})
  })

  it('shows one of two entries that claim the same UID, and the same one whatever order they arrive in', () => {
    const first = fetched('a.ics', 'same', 'F1')
    const second = fetched('b.ics', 'same', 'F2')
    for (const remote of [
      [first, second],
      [second, first],
    ]) {
      const plan = planPull(input([], {}, remote))
      expect(plan.write).toEqual([{ id: id('same'), name: 'a.ics', fingerprint: 'F1' }])
      expect(plan.unreadable).toEqual({ 'b.ics': 'duplicate-uid' })
    }
  })

  it('follows an entry the server renamed', () => {
    const plan = planPull(
      input([[id('a'), 'A1']], { [id('a')]: { h: 'old.ics', b: 'A1' } }, [fetched('new.ics', 'a', 'A1')]),
    )
    expect(plan.write).toEqual([])
    expect(plan.remove).toEqual([])
    expect(plan.records).toEqual({ [id('a')]: { h: 'new.ics', b: 'A1' } })
  })

  describe('over generated cases', () => {
    let state = 0x1234abcd
    const next = (): number => {
      state = (state + 0x6d2b79f5) | 0
      let t = Math.imul(state ^ (state >>> 15), 1 | state)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]

    /** A note and a server in any relation to each other: agreeing, diverged, missing on either side. */
    const anyCase = (uids: number): PullPlanInput => {
      const local: [string, string][] = []
      const records: Record<string, DavEntryRecord> = {}
      const remote: RemoteEntry[] = []
      for (let index = 0; index < uids; index++) {
        const uid = `uid-${index}`
        const name = `${uid}.ics`
        const base = `base-${index}`
        const inNote = pick(['agreed', 'changed', 'absent'] as const)
        const remembered = next() < 0.8
        const onServer = pick(['same', 'changed', 'unreadable', 'not-listed'] as const)
        if (inNote !== 'absent') {
          local.push([id(uid), inNote === 'agreed' ? base : `local-${index}`])
        }
        if (remembered) {
          records[id(uid)] = { h: name, b: base }
        }
        if (onServer === 'unreadable') {
          remote.push({ name, state: 'unreadable', reason: 'no-usable-start' })
        } else if (onServer !== 'not-listed') {
          const fingerprint = onServer === 'same' ? base : `remote-${index}`
          // An entry is fetched whenever the pass cannot vouch for the note's copy; only an agreed,
          // remembered one may be merely listed.
          const mayBeListedOnly = onServer === 'same' && remembered && inNote === 'agreed'
          remote.push(mayBeListedOnly && next() < 0.5 ? { name, state: 'unchanged' } : fetched(name, uid, fingerprint))
        }
      }
      if (next() < 0.3) {
        local.push([`evt-own-${Math.floor(next() * 1000)}`, 'own'])
      }
      return { local: new Map(local), records, remote }
    }

    /** The note and records as they are after a plan has been carried out. */
    const carryOut = (given: PullPlanInput): PullPlanInput => {
      const plan = planPull(given)
      const local = new Map(given.local)
      for (const removed of plan.remove) {
        local.delete(removed)
      }
      for (const written of plan.write) {
        local.set(written.id, written.fingerprint)
      }
      return { local, records: plan.records, remote: given.remote }
    }

    it('gives the same plan for the same inputs, whatever order the listing came in', () => {
      for (let round = 0; round < 300; round++) {
        const given = anyCase(1 + Math.floor(next() * 12))
        const shuffled = { ...given, remote: [...given.remote].sort(() => next() - 0.5) }
        expect(planPull(shuffled)).toEqual(planPull(given))
      }
    })

    it('has nothing left to do after it has been carried out', () => {
      let writes = 0
      for (let round = 0; round < 500; round++) {
        const given = anyCase(1 + Math.floor(next() * 12))
        writes += planPull(given).write.length
        const again = planPull(carryOut(given))
        expect(again.write).toEqual([])
        expect(again.remove).toEqual([])
        expect(again.records).toEqual(planPull(given).records)
      }
      // The cases really did call for work the first time.
      expect(writes).toBeGreaterThan(500)
    })

    it('never removes anything from a note that holds nothing from the server yet', () => {
      for (let round = 0; round < 300; round++) {
        const given = anyCase(1 + Math.floor(next() * 12))
        const firstLink: PullPlanInput = {
          local: new Map([...given.local].filter(([eventId]) => eventId.startsWith('evt-'))),
          records: {},
          remote: given.remote,
        }
        expect(planPull(firstLink).remove).toEqual([])
      }
    })

    it('never removes or rewrites an event that did not come from the server', () => {
      let own = 0
      for (let round = 0; round < 500; round++) {
        const given = anyCase(1 + Math.floor(next() * 12))
        const plan = planPull(given)
        const touched = new Set([...plan.remove, ...plan.write.map((entry) => entry.id)])
        for (const eventId of given.local.keys()) {
          if (eventId.startsWith('evt-')) {
            own += 1
            expect(touched.has(eventId)).toBe(false)
          }
        }
      }
      expect(own).toBeGreaterThan(50)
    })

    it('never removes the note’s copy of an entry that is listed, readable or not', () => {
      for (let round = 0; round < 500; round++) {
        const given = anyCase(1 + Math.floor(next() * 12))
        const plan = planPull(given)
        const listedNames = new Set(given.remote.map((entry) => entry.name))
        const namesWithARecord = new Set(Object.values(given.records).map((record) => record.h))
        const everyListedEntryIsIdentified = given.remote.every(
          (entry) => entry.state === 'fetched' || namesWithARecord.has(entry.name),
        )
        for (const removed of plan.remove) {
          const record = given.records[removed]
          if (record !== undefined) {
            // The note remembers it under a name the server no longer lists.
            expect(listedNames.has(record.h)).toBe(false)
          } else {
            // It has no record, so it can only go when no listed entry could still turn out to be it.
            expect(everyListedEntryIsIdentified).toBe(true)
          }
        }
      }
    })
  })
})

describe('brakeFor', () => {
  const noteOf = (count: number) => {
    const local: [string, string][] = []
    const records: Record<string, DavEntryRecord> = {}
    for (let index = 0; index < count; index++) {
      local.push([id(`u${index}`), `B${index}`])
      records[id(`u${index}`)] = { h: `u${index}.ics`, b: `B${index}` }
    }
    return { local, records }
  }
  const listing = (count: number, from = 0): RemoteEntry[] =>
    Array.from({ length: count }, (_unused, index) => ({ name: `u${from + index}.ics`, state: 'unchanged' as const }))
  const brake = (held: number, listed: RemoteEntry[]) => {
    const { local, records } = noteOf(held)
    const given = input(local, records, listed)
    return brakeFor(planPull(given), given)
  }

  it('lets a few removals through', () => {
    expect(brake(40, listing(40 - BRAKE_MIN_REMOVALS))).toBeUndefined()
    expect(brake(3, [])).toBeUndefined()
  })

  it('stops a pass that would empty a calendar because the listing came back empty', () => {
    expect(brake(6, [])).toEqual({ kind: 'empty-listing', removals: 6, held: 6 })
  })

  it('stops a pass that would remove more than five entries and more than a tenth of the calendar', () => {
    expect(brake(40, listing(34))).toEqual({ kind: 'many-removals', removals: 6, held: 40 })
    // In a large calendar a tenth is the larger allowance: 30 of 300 pass, 31 do not.
    expect(brake(300, listing(270))).toBeUndefined()
    expect(brake(300, listing(269))).toEqual({ kind: 'many-removals', removals: 31, held: 300 })
  })

  it('does not stop a first import, however large', () => {
    const remote = Array.from({ length: 500 }, (_unused, index) => fetched(`n${index}.ics`, `n${index}`, `F${index}`))
    const given = input([], {}, remote)
    const plan = planPull(given)
    expect(plan.write).toHaveLength(500)
    expect(brakeFor(plan, given)).toBeUndefined()
  })
})
