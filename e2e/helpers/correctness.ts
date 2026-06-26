import { type Page } from '@playwright/test'

/**
 * CORRECTNESS-at-scale helpers for the Standard Red Notes harness.
 *
 * WHY THIS EXISTS (separate from stress.ts):
 * stress.ts only seeds flat, identical notes and measures open/scroll/heap. It
 * would let a DATA-INTEGRITY regression pass green. The upcoming "windowed
 * materialization" data-layer change (keep only the visible window + working set
 * as full items, the rest as a compact metadata index) can SILENTLY break:
 *   - reference resolution (tag <-> note links),
 *   - tag membership / tag-filter results,
 *   - the search index,
 *   - edit -> save -> reload of a possibly-"lite" (body-stripped) note.
 * These helpers seed a vault with STRUCTURE (tags attached to known notes, notes
 * carrying a unique search token) and assert that structure SURVIVES a cold
 * reload from IndexedDB. This is the GATE that must catch such a regression.
 *
 * IN-PAGE APP SURFACE (verified against app source):
 *   window.mainApplicationGroup.primaryApplication is the snjs Application, with:
 *     app.mutator.createItem(ct, content, needsSync)         create note/tag
 *     app.mutator.createTagOrSmartView(title)                create a real tag (no sync)
 *     app.mutator.addTagToNote(note, tag, addHierarchy)      link tag -> note (tag refs note)
 *     app.mutator.changeItem(item, mutate)                   edit (marks dirty)
 *     app.sync.sync(opts)                                    flush dirty -> IndexedDB
 *     app.sync.getFullContentPayload(uuid)                   re-hydrate a lite note's body
 *     app.items.getItems(ct) / findItem(uuid)                in-memory item lookup
 *     app.items.getSortedTagsForItem(note)                   tags attached to a note
 *     app.items.itemsReferencingItem({uuid}, ct)             reverse refs (tag membership)
 *     app.items.getDisplayableNotes()                        the list the UI renders
 *     app.items.setPrimaryItemDisplayOptions(criteria)       drive tag-filter / search
 *       criteria.tags=[tag]                                  scope to a tag (UI tag click)
 *       criteria.searchQuery={query, includeProtectedNoteText} run the list search
 *
 * The tag-filter (check 2) and search (check 3) drive EXACTLY the same
 * `setPrimaryItemDisplayOptions` + `getDisplayableNotes()` path the web
 * ItemListController uses (see Controllers/ItemList/ItemListController.ts
 * reloadNotesDisplayOptions), so a regression that breaks the real UI breaks
 * this assertion too.
 *
 * SEARCH + lazy-decrypt: the model search matcher (models .../Search/
 * SearchUtilities.ts) matches a note when the query hits its TITLE or its BODY,
 * and when a note is "lite" (body stripped under the lazy-decrypt flag) it falls
 * back to the always-resident preview. So we seed the unique token into BOTH the
 * title and the body: the title hit guarantees the search assertion holds in
 * either flag state, while the body still exercises the full-text path when the
 * flag is off.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const TOKEN_NOTE_TITLE_PREFIX = 'TokenNote'

export type StructureSeedResult = {
  notesCreated: number
  tagsCreated: number
  /** uuid -> the tag titles we attached to that note. */
  taggedNotes: Record<string, string[]>
  /** tag title -> uuids of notes we placed in that tag. */
  tagMembership: Record<string, string[]>
  /** uuids of the notes that carry the unique search token. */
  tokenNoteUuids: string[]
  /** the unique search token seeded into those notes' title + body. */
  searchToken: string
  /** a uuid chosen for the edit->save->reload round-trip. */
  editNoteUuid: string
  seedMs: number
}

/**
 * Seed `count` plain notes, then OVERLAY structure:
 *   - `tagCount` real tags,
 *   - attach each tag to a deterministic, known subset of notes,
 *   - mark `tokenNoteCount` notes with a unique token in title + body,
 *   - pick one note as the edit-roundtrip target.
 * Everything is flushed to IndexedDB via a final sync, so it survives a reload.
 *
 * Returns the GROUND TRUTH (which tags on which notes, which notes hold the
 * token, the edit target) the post-reload assertions compare against.
 */
export async function seedStructuredVault(
  page: Page,
  opts: {
    count: number
    sizeBytes?: number
    tagCount?: number
    notesPerTag?: number
    tokenNoteCount?: number
    batchSize?: number
  },
): Promise<StructureSeedResult> {
  const sizeBytes = opts.sizeBytes ?? 512
  const tagCount = opts.tagCount ?? 5
  const notesPerTag = opts.notesPerTag ?? 8
  const tokenNoteCount = opts.tokenNoteCount ?? 4
  const batchSize = opts.batchSize ?? 1000
  // Collision-resistant token so it cannot pre-exist in any other note's filler.
  const searchToken = `ZQX${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`.toUpperCase()

  return page.evaluate(
    async ({ count, sizeBytes, tagCount, notesPerTag, tokenNoteCount, batchSize, searchToken, titlePrefix }) => {
      const app = (window as any).mainApplicationGroup?.primaryApplication
      if (!app) throw new Error('window.mainApplicationGroup.primaryApplication not available')

      const filler = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '
      const reps = Math.max(1, Math.ceil(sizeBytes / filler.length))
      const body = filler.repeat(reps).slice(0, Math.max(0, sizeBytes))

      const seedStart = performance.now()

      // 1) Bulk-seed the plain corpus via emit+sync (same path as stress.ts).
      const LOCAL_INSERTED = 3
      const base = await app.mutator.createItem('Note', { title: 'seed-base', text: body }, false)
      const basePayload = base.payload as { copy: (o: Record<string, unknown>) => unknown; content: Record<string, unknown> }
      const plainUuids: string[] = []
      for (let start = 0; start < count; start += batchSize) {
        const end = Math.min(start + batchSize, count)
        const payloads: unknown[] = []
        for (let i = start; i < end; i += 1) {
          const uuid = crypto.randomUUID()
          plainUuids.push(uuid)
          payloads.push(
            basePayload.copy({
              uuid,
              content: { ...basePayload.content, title: `Stress note ${i + 1}`, text: `${i + 1} ${body}` },
              dirty: true,
            }),
          )
        }
        await app.mutator.emitItemsFromPayloads(payloads, LOCAL_INSERTED)
        await app.sync.sync({ sourceDescription: 'correctness-seed-notes' })
      }

      // 2) Mark a known subset of notes with a UNIQUE token in TITLE + BODY.
      //    Title hit => search matches even when the body is stripped (lite mode).
      const tokenNoteUuids: string[] = []
      for (let k = 0; k < tokenNoteCount; k += 1) {
        // Spread token notes across the corpus so they aren't all in one window.
        const idx = Math.floor((k * count) / Math.max(1, tokenNoteCount))
        const uuid = plainUuids[Math.min(idx, plainUuids.length - 1)]
        const note = app.items.findItem(uuid)
        if (!note) continue
        await app.mutator.changeItem(note, (m: any) => {
          m.mutableContent.title = `${titlePrefix} ${searchToken} ${k + 1}`
          m.mutableContent.text = `${searchToken} body marker ${k + 1} ${body}`
        })
        tokenNoteUuids.push(uuid)
      }

      // 3) Create real tags and attach each to a deterministic, KNOWN subset of notes.
      //    addTagToNote makes the TAG reference the NOTE (tags reference notes).
      const taggedNotes: Record<string, string[]> = {}
      const tagMembership: Record<string, string[]> = {}
      // NB: the tag titles must NOT contain `searchToken`. The in-app search
      // (models .../Search/SearchUtilities.itemMatchesQuery) ALSO matches a note
      // when any of its TAGS' titles match the query (someTagsMatches). If the
      // token were in the tag titles, every tagged note would (correctly) match
      // the token search and pollute the check-3 token-note set. Use a separate,
      // token-free tag suffix so the token search only hits the seeded token notes.
      const tagSuffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      for (let t = 0; t < tagCount; t += 1) {
        const tagTitle = `CorrectnessTag-${t}-${tagSuffix}`
        const tag = await app.mutator.createTagOrSmartView(tagTitle)
        tagMembership[tagTitle] = []
        // Pick `notesPerTag` notes by a stride that interleaves tags' members.
        for (let m = 0; m < notesPerTag; m += 1) {
          const idx = (t + m * tagCount) % Math.max(1, plainUuids.length)
          const noteUuid = plainUuids[idx]
          const note = app.items.findItem(noteUuid)
          if (!note) continue
          await app.mutator.addTagToNote(note, tag, false)
          tagMembership[tagTitle].push(noteUuid)
          ;(taggedNotes[noteUuid] ||= []).push(tagTitle)
        }
      }

      // 4) Pick a stable edit-roundtrip target: a plain note NOT carrying the
      //    token and NOT tagged, so the edit can't perturb checks 1-3. (The token
      //    notes sit at strided indices incl. count/2, so avoid that midpoint.)
      const tokenSet = new Set(tokenNoteUuids)
      const taggedSet = new Set(Object.keys(taggedNotes))
      const editNoteUuid =
        plainUuids.find((u, i) => i > 7 && !tokenSet.has(u) && !taggedSet.has(u)) ??
        plainUuids[plainUuids.length - 1]

      // 5) Flush all structure (token edits + tags + tag refs) to IndexedDB.
      await app.sync.sync({ sourceDescription: 'correctness-seed-structure' })

      return {
        notesCreated: app.items.getItems('Note').length,
        tagsCreated: app.items.getItems('Tag').length,
        taggedNotes,
        tagMembership,
        tokenNoteUuids,
        searchToken,
        editNoteUuid,
        seedMs: performance.now() - seedStart,
      }
    },
    { count: opts.count, sizeBytes, tagCount, notesPerTag, tokenNoteCount, batchSize, searchToken, titlePrefix: TOKEN_NOTE_TITLE_PREFIX },
  )
}

/**
 * CHECK 1 — tags & references survived the cold reload.
 * For every note we tagged, assert getSortedTagsForItem returns EXACTLY the
 * expected tag titles; and for every tag, assert its membership (notes that
 * reference it) matches the seeded set. Pure reference-resolution integrity.
 */
export async function assertTagsAndReferences(
  page: Page,
  ground: { taggedNotes: Record<string, string[]>; tagMembership: Record<string, string[]> },
): Promise<{
  notesChecked: number
  noteTagMismatches: Array<{ uuid: string; expected: string[]; got: string[] }>
  tagsChecked: number
  membershipMismatches: Array<{ tag: string; expected: number; got: number; missing: string[]; extra: string[] }>
}> {
  return page.evaluate((ground) => {
    const app = (window as any).mainApplicationGroup?.primaryApplication
    if (!app) throw new Error('app not available')

    const sortStr = (a: string[]) => [...a].sort()

    // Per-note: getSortedTagsForItem must equal the expected tag titles.
    const noteTagMismatches: Array<{ uuid: string; expected: string[]; got: string[] }> = []
    const taggedUuids = Object.keys(ground.taggedNotes)
    for (const uuid of taggedUuids) {
      const note = app.items.findItem(uuid)
      const got = note
        ? sortStr((app.items.getSortedTagsForItem(note) as Array<{ title: string }>).map((t) => t.title))
        : []
      const expected = sortStr(ground.taggedNotes[uuid])
      if (JSON.stringify(got) !== JSON.stringify(expected)) {
        noteTagMismatches.push({ uuid, expected, got })
      }
    }

    // Per-tag: the notes referencing the tag must equal the seeded membership.
    const membershipMismatches: Array<{
      tag: string
      expected: number
      got: number
      missing: string[]
      extra: string[]
    }> = []
    const tags = app.items.getItems('Tag') as Array<{ uuid: string; title: string }>
    const tagByTitle = new Map(tags.map((t) => [t.title, t]))
    let tagsChecked = 0
    for (const tagTitle of Object.keys(ground.tagMembership)) {
      const tag = tagByTitle.get(tagTitle)
      const expectedSet = new Set(ground.tagMembership[tagTitle])
      tagsChecked += 1
      if (!tag) {
        membershipMismatches.push({
          tag: tagTitle,
          expected: expectedSet.size,
          got: 0,
          missing: [...expectedSet],
          extra: [],
        })
        continue
      }
      // Notes the tag references (tag.references -> note). Use the note-side
      // reverse lookup for robustness: which notes carry this tag.
      const members = (app.items.getItems('Note') as Array<{ uuid: string }>).filter((n) => {
        const note = app.items.findItem(n.uuid)
        if (!note) return false
        return (app.items.getSortedTagsForItem(note) as Array<{ uuid: string }>).some((t) => t.uuid === tag.uuid)
      })
      const gotSet = new Set(members.map((n) => n.uuid))
      const missing = [...expectedSet].filter((u) => !gotSet.has(u))
      const extra = [...gotSet].filter((u) => !expectedSet.has(u))
      if (missing.length || extra.length) {
        membershipMismatches.push({
          tag: tagTitle,
          expected: expectedSet.size,
          got: gotSet.size,
          missing,
          extra,
        })
      }
    }

    return { notesChecked: taggedUuids.length, noteTagMismatches, tagsChecked, membershipMismatches }
  }, ground)
}

/**
 * CHECK 2 — tag filter.
 * Drive the SAME display path the UI uses: scope the primary display to a tag,
 * then read getDisplayableNotes(). Assert the visible set equals exactly the
 * notes seeded into that tag.
 */
export async function assertTagFilter(
  page: Page,
  ground: { tagMembership: Record<string, string[]> },
): Promise<Array<{ tag: string; expected: number; got: number; missing: string[]; extra: string[] }>> {
  return page.evaluate((ground) => {
    const app = (window as any).mainApplicationGroup?.primaryApplication
    if (!app) throw new Error('app not available')

    const tags = app.items.getItems('Tag') as Array<{ uuid: string; title: string }>
    const tagByTitle = new Map(tags.map((t) => [t.title, t]))

    const mismatches: Array<{ tag: string; expected: number; got: number; missing: string[]; extra: string[] }> = []
    for (const tagTitle of Object.keys(ground.tagMembership)) {
      const tag = tagByTitle.get(tagTitle)
      const expectedSet = new Set(ground.tagMembership[tagTitle])
      if (!tag) {
        mismatches.push({ tag: tagTitle, expected: expectedSet.size, got: 0, missing: [...expectedSet], extra: [] })
        continue
      }
      app.items.setPrimaryItemDisplayOptions({
        tags: [tag],
        searchQuery: { query: '', includeProtectedNoteText: false },
      })
      const visible = app.items.getDisplayableNotes() as Array<{ uuid: string }>
      const gotSet = new Set(visible.map((n) => n.uuid))
      const missing = [...expectedSet].filter((u) => !gotSet.has(u))
      const extra = [...gotSet].filter((u) => !expectedSet.has(u))
      if (missing.length || extra.length) {
        mismatches.push({ tag: tagTitle, expected: expectedSet.size, got: gotSet.size, missing, extra })
      }
    }

    // Reset display options so later checks see the full corpus.
    app.items.setPrimaryItemDisplayOptions({
      tags: [],
      searchQuery: { query: '', includeProtectedNoteText: false },
    })
    return mismatches
  }, ground)
}

/**
 * CHECK 3 — search.
 * Run the in-app list search (setPrimaryItemDisplayOptions + searchQuery) for the
 * unique token, then assert the matched note set equals EXACTLY the seeded token
 * notes. Robust to lazy-decrypt: the token is in the TITLE (always resident) so
 * the match holds even when bodies are stripped; we also verify via the
 * re-hydrated full body for any matched note to prove the deep path.
 */
export async function assertSearch(
  page: Page,
  ground: { searchToken: string; tokenNoteUuids: string[] },
): Promise<{
  query: string
  expected: number
  matched: number
  missing: string[]
  extra: string[]
  bodyTokenConfirmed: number
  liteEncountered: number
}> {
  return page.evaluate(async (ground) => {
    const app = (window as any).mainApplicationGroup?.primaryApplication
    if (!app) throw new Error('app not available')

    app.items.setPrimaryItemDisplayOptions({
      tags: [],
      searchQuery: { query: ground.searchToken, includeProtectedNoteText: true },
    })
    const visible = app.items.getDisplayableNotes() as Array<{ uuid: string }>
    const gotSet = new Set(visible.map((n) => n.uuid))
    const expectedSet = new Set(ground.tokenNoteUuids)
    const missing = [...expectedSet].filter((u) => !gotSet.has(u))
    const extra = [...gotSet].filter((u) => !expectedSet.has(u))

    // Deep path: for each matched note, confirm the token is in the FULL body —
    // either the resident text, or the re-hydrated payload when the note is lite.
    let bodyTokenConfirmed = 0
    let liteEncountered = 0
    const isLite = (p: any) => Boolean(p && (p.content == null || p.content?.text === undefined) && p.preview_plain !== undefined)
    for (const uuid of gotSet) {
      const note = app.items.findItem(uuid)
      if (!note) continue
      let text: string = note.text ?? ''
      const lite = !text && typeof app.sync.getFullContentPayload === 'function'
      if (lite) {
        liteEncountered += 1
        const full = await app.sync.getFullContentPayload(uuid)
        text = (full?.content as { text?: string } | undefined)?.text ?? ''
      }
      if (text.includes(ground.searchToken)) bodyTokenConfirmed += 1
    }

    // Reset display options.
    app.items.setPrimaryItemDisplayOptions({
      tags: [],
      searchQuery: { query: '', includeProtectedNoteText: false },
    })

    return {
      query: ground.searchToken,
      expected: expectedSet.size,
      matched: gotSet.size,
      missing,
      extra,
      bodyTokenConfirmed,
      liteEncountered,
    }
  }, ground)
}

/**
 * CHECK 4 setup — edit a note's text via the mutator and persist (local sync).
 * Returns the new text written. Run this BEFORE the reload; assert after.
 */
export async function editAndPersistNote(
  page: Page,
  uuid: string,
): Promise<{ uuid: string; newText: string; wasLite: boolean }> {
  return page.evaluate(async (uuid) => {
    const app = (window as any).mainApplicationGroup?.primaryApplication
    if (!app) throw new Error('app not available')
    const note = app.items.findItem(uuid)
    if (!note) throw new Error(`edit target ${uuid} not found`)
    const wasLite = !((note.text ?? '').length > 0)
    const newText = `EDITED-ROUNDTRIP ${Date.now().toString(36)} reload-survives`

    // If a note came back lite, re-hydrate its full payload before mutating so the
    // mutation is against real content (the editor-open path).
    if (wasLite && typeof app.sync.getFullContentPayload === 'function') {
      const full = await app.sync.getFullContentPayload(uuid)
      if (full) await app.mutator.emitItemFromPayload(full, 3 /* LocalDatabaseLoaded-ish */)
    }
    const live = app.items.findItem(uuid)
    await app.mutator.changeItem(live, (m: any) => {
      m.mutableContent.text = newText
    })
    await app.sync.sync({ sourceDescription: 'correctness-edit-roundtrip' })
    return { uuid, newText, wasLite }
  }, uuid)
}

/**
 * CHECK 4 assert — after the reload, confirm the edited note's persisted text
 * equals what we wrote (re-hydrating if the reloaded note is lite).
 */
export async function assertEditedNoteText(
  page: Page,
  uuid: string,
  expectedText: string,
): Promise<{ uuid: string; found: boolean; matches: boolean; wasLite: boolean; got: string }> {
  return page.evaluate(
    async ({ uuid, expectedText }) => {
      const app = (window as any).mainApplicationGroup?.primaryApplication
      if (!app) throw new Error('app not available')
      const note = app.items.findItem(uuid)
      if (!note) return { uuid, found: false, matches: false, wasLite: false, got: '' }
      let got: string = note.text ?? ''
      const wasLite = !got.length
      if (wasLite && typeof app.sync.getFullContentPayload === 'function') {
        const full = await app.sync.getFullContentPayload(uuid)
        got = (full?.content as { text?: string } | undefined)?.text ?? got
      }
      return { uuid, found: true, matches: got === expectedText, wasLite, got: got.slice(0, 80) }
    },
    { uuid, expectedText },
  )
}

/** Count Note + Tag items currently in memory (settled-load verification). */
export async function itemCounts(page: Page): Promise<{ notes: number; tags: number }> {
  return page.evaluate(() => {
    const app = (window as any).mainApplicationGroup?.primaryApplication
    return app ? { notes: app.items.getItems('Note').length, tags: app.items.getItems('Tag').length } : { notes: -1, tags: -1 }
  })
}
