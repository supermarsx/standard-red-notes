import { test } from 'node:test'
import assert from 'node:assert/strict'

import { collectTags, flagStr, parseArgs } from '../src/args.ts'

test('parseArgs splits positionals from flags', () => {
  const { _, flags } = parseArgs(['notes', 'get', 'abc-123'])
  assert.deepEqual(_, ['notes', 'get', 'abc-123'])
  assert.deepEqual(flags, {})
})

test('parseArgs reads --key=value without consuming the next token', () => {
  const { _, flags } = parseArgs(['--title=Hello World', 'positional'])
  assert.equal(flags.title, 'Hello World')
  assert.deepEqual(_, ['positional'])
})

test('parseArgs keeps everything after the first = in --key=value', () => {
  // Matters for URLs and base64-ish secrets, which legitimately contain "=".
  const { flags } = parseArgs(['--server=http://h/p?a=1&b=2', '--password=pw=='])
  assert.equal(flags.server, 'http://h/p?a=1&b=2')
  assert.equal(flags.password, 'pw==')
})

test('parseArgs reads --key value and skips the consumed value', () => {
  const { _, flags } = parseArgs(['notes', '--limit', '20'])
  assert.equal(flags.limit, '20')
  assert.deepEqual(_, ['notes'], 'the consumed value must not leak into positionals')
})

test('parseArgs treats a flag followed by another flag as boolean', () => {
  const { flags } = parseArgs(['--json', '--limit', '5'])
  assert.equal(flags.json, true)
  assert.equal(flags.limit, '5')
})

test('parseArgs treats a trailing flag as boolean', () => {
  assert.equal(parseArgs(['export', '--json']).flags.json, true)
})

test('parseArgs maps -h to help', () => {
  assert.equal(parseArgs(['-h']).flags.help, true)
  assert.equal(parseArgs(['notes', '-h']).flags.help, true)
})

test('parseArgs lets a later occurrence win', () => {
  assert.equal(parseArgs(['--format', 'json', '--format', 'md']).flags.format, 'md')
})

test('parseArgs accepts an empty --key= value rather than turning it into a boolean', () => {
  assert.equal(parseArgs(['--text=']).flags.text, '')
})

test('flagStr returns undefined for boolean flags, so a bare --title is not a title', () => {
  const { flags } = parseArgs(['notes', 'create', '--title'])
  assert.equal(flags.title, true)
  assert.equal(flagStr(flags, 'title'), undefined)
})

test('flagStr returns undefined for absent flags', () => {
  assert.equal(flagStr({}, 'nope'), undefined)
})

test('flagStr returns the empty string as a real value', () => {
  assert.equal(flagStr({ text: '' }, 'text'), '')
})

test('collectTags splits a comma list and trims each entry', () => {
  assert.deepEqual(collectTags(parseArgs(['--tag', 'inbox, ideas ,work'])), ['inbox', 'ideas', 'work'])
})

test('collectTags drops empty segments from sloppy input', () => {
  assert.deepEqual(collectTags(parseArgs(['--tag=a,,b,'])), ['a', 'b'])
})

test('collectTags falls back to --tags', () => {
  assert.deepEqual(collectTags(parseArgs(['--tags', 'x,y'])), ['x', 'y'])
})

test('collectTags prefers --tag over --tags when both are given', () => {
  assert.deepEqual(collectTags(parseArgs(['--tags', 'x', '--tag', 'y'])), ['y'])
})

test('collectTags returns [] when no tag flag is present or it is boolean', () => {
  assert.deepEqual(collectTags(parseArgs(['notes', 'list'])), [])
  assert.deepEqual(collectTags(parseArgs(['--tag'])), [])
})
