import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeImportRecord, parseImportPayload, toMarkdown, type ExportableNote } from '../src/transform.ts'

const note = (over: Partial<ExportableNote> = {}): ExportableNote => ({
  uuid: 'u1',
  title: 'Title',
  text: 'Body',
  tags: [],
  updatedAt: '2026-01-02T03:04:05.000Z',
  ...over,
})

test('toMarkdown emits a heading, a metadata comment and the body', () => {
  const md = toMarkdown([note()])
  assert.equal(md, '# Title\n<!-- uuid: u1 | updated: 2026-01-02T03:04:05.000Z -->\n\nBody')
})

test('toMarkdown includes tags in the metadata comment only when present', () => {
  assert.match(toMarkdown([note({ tags: ['a', 'b'] })]), /\| tags: a, b -->/)
  assert.doesNotMatch(toMarkdown([note({ tags: [] })]), /tags:/)
})

test('toMarkdown labels an untitled note instead of emitting a bare "# "', () => {
  assert.match(toMarkdown([note({ title: '' })]), /^# \(untitled\)\n/)
})

test('toMarkdown separates notes with a horizontal rule', () => {
  const md = toMarkdown([note({ uuid: 'a', title: 'A' }), note({ uuid: 'b', title: 'B' })])
  assert.equal(md.split('\n\n---\n\n').length, 2)
  assert.ok(md.includes('# A') && md.includes('# B'))
})

test('toMarkdown returns an empty string for no notes', () => {
  assert.equal(toMarkdown([]), '')
})

test('parseImportPayload returns the records of a JSON array', () => {
  assert.deepEqual(parseImportPayload('[{"title":"a"},{"title":"b"}]', 'f.json'), [{ title: 'a' }, { title: 'b' }])
})

test('parseImportPayload rejects malformed JSON, naming the file', () => {
  assert.throws(() => parseImportPayload('{not json', 'notes.json'), /notes\.json is not valid JSON/)
})

test('parseImportPayload rejects a JSON object (import expects an array)', () => {
  assert.throws(() => parseImportPayload('{"title":"a"}', 'f.json'), /must be a JSON array/)
})

test('parseImportPayload rejects a bare JSON scalar', () => {
  // JSON.parse succeeds here, so only the Array check can catch it.
  assert.throws(() => parseImportPayload('"just a string"', 'f.json'), /must be a JSON array/)
  assert.throws(() => parseImportPayload('null', 'f.json'), /must be a JSON array/)
})

test('normalizeImportRecord passes through a well-formed record', () => {
  assert.deepEqual(normalizeImportRecord({ title: 'T', text: 'B', tags: ['x'] }), {
    title: 'T',
    text: 'B',
    tags: ['x'],
  })
})

test('normalizeImportRecord skips records with neither title nor text', () => {
  assert.equal(normalizeImportRecord({}), undefined)
  assert.equal(normalizeImportRecord({ title: '', text: '' }), undefined)
  assert.equal(normalizeImportRecord({ tags: ['orphan'] }), undefined, 'tags alone must not create a note')
})

test('normalizeImportRecord keeps a text-only record and labels it untitled', () => {
  assert.deepEqual(normalizeImportRecord({ text: 'body' }), { title: '(untitled)', text: 'body', tags: [] })
})

test('normalizeImportRecord discards non-string fields instead of stringifying them', () => {
  const junk = { title: 42, text: { a: 1 }, tags: 'not-an-array' } as unknown as Parameters<
    typeof normalizeImportRecord
  >[0]
  assert.equal(normalizeImportRecord(junk), undefined, 'a numeric title is not a title')

  const mixed = { title: 'ok', text: { a: 1 }, tags: 'not-an-array' } as unknown as Parameters<
    typeof normalizeImportRecord
  >[0]
  assert.deepEqual(normalizeImportRecord(mixed), { title: 'ok', text: '', tags: [] })
})

test('normalizeImportRecord filters non-string entries out of tags', () => {
  const rec = { title: 't', tags: ['a', 7, null, 'b'] } as unknown as Parameters<typeof normalizeImportRecord>[0]
  assert.deepEqual(normalizeImportRecord(rec)?.tags, ['a', 'b'])
})
