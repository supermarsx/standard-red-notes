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

// --- valueless boolean flags -------------------------------------------------
//
// Regression: boolean switches were not declared, so the parser could not tell
// `--json <uuid>` (switch + note id) from `--limit 20` (flag + value). It bound
// the following token as the switch's VALUE, removing it from the positionals —
// `notes get --json <uuid>` lost the uuid and died with a usage error.

const BOOLEANS = ['help', 'register', 'json']

for (const name of BOOLEANS) {
  test(`--${name} is boolean true when followed by a positional, and keeps the positional`, () => {
    const { _, flags } = parseArgs([`--${name}`, 'a-uuid'])
    assert.equal(flags[name], true, `--${name} must not bind "a-uuid" as its value`)
    assert.deepEqual(_, ['a-uuid'], `--${name} must not consume the positional`)
  })

  test(`--${name} is boolean true at the end of argv`, () => {
    assert.equal(parseArgs([`--${name}`]).flags[name], true)
  })

  test(`--${name} is boolean true when followed by another flag`, () => {
    const { flags } = parseArgs([`--${name}`, '--limit', '5'])
    assert.equal(flags[name], true)
    assert.equal(flags.limit, '5')
  })
}

test('notes get keeps its uuid when --json comes first', () => {
  // The exact invocation that used to fail with "Usage: srn-client notes get <uuid>".
  const args = parseArgs(['notes', 'get', '--json', '11111111-2222-3333-4444-555555555555'])
  assert.equal(args.flags.json, true)
  assert.deepEqual(args._, ['notes', 'get', '11111111-2222-3333-4444-555555555555'])
})

test('notes delete keeps its uuid when --json comes first, and targets ONLY that uuid', () => {
  const args = parseArgs(['notes', 'delete', '--json', 'uuid-a'])
  assert.equal(args.flags.json, true)
  assert.deepEqual(args._, ['notes', 'delete', 'uuid-a'])
  // `cmdNotes` shifts the command then the subcommand, leaving _[0] as the
  // single delete target. Exactly one uuid must survive — never zero (which
  // used to happen) and never more than the user typed.
  const afterShifts = args._.slice(2)
  assert.deepEqual(afterShifts, ['uuid-a'])
})

test('notes delete resolves exactly ONE target, never a broader set', () => {
  // Safety property, not just parsing: `cmdNotes` reads only _[0] as the delete
  // target and NotesClient.deleteNote takes a single uuid resolved by exact
  // match. Extra positionals must be IGNORED, never deleted as well.
  const cases = [
    ['notes', 'delete', 'uuid-a'],
    ['notes', 'delete', '--json', 'uuid-a'],
    ['notes', 'delete', 'uuid-a', 'uuid-b'],
    ['notes', 'delete', '--json', 'uuid-a', 'uuid-b'],
  ]
  for (const argv of cases) {
    const targets = parseArgs(argv)._.slice(2) // after the command + subcommand shifts
    assert.equal(targets[0], 'uuid-a', `${argv.join(' ')} must target the uuid the user typed first`)
    assert.ok(targets.length <= 2, `${argv.join(' ')} must not fan out into extra targets`)
  }
})

test('notes delete with no uuid still fails loudly rather than targeting anything', () => {
  assert.deepEqual(parseArgs(['notes', 'delete', '--json'])._.slice(2), [], 'no uuid -> no target, so cmdNotes fails')
})

test('the notes SUBCOMMAND survives a leading --json', () => {
  // `notes --json list` used to bind "list" to --json, leaving no subcommand
  // and reporting "Unknown notes subcommand: (none)".
  const args = parseArgs(['notes', '--json', 'list'])
  assert.equal(args.flags.json, true)
  assert.deepEqual(args._, ['notes', 'list'])
})

test('value-taking flags still consume their value', () => {
  // The fix must not turn every flag into a boolean.
  const { _, flags } = parseArgs(['notes', 'create', '--title', 'T', '--text', 'B', '--tag', 'a,b', '--limit', '5'])
  assert.equal(flags.title, 'T')
  assert.equal(flags.text, 'B')
  assert.equal(flags.tag, 'a,b')
  assert.equal(flags.limit, '5')
  assert.deepEqual(_, ['notes', 'create'])
})

test('credential flags still consume their value', () => {
  const { flags } = parseArgs([
    'login',
    '--server',
    'http://h:3001',
    '--email',
    'me@x.com',
    '--password',
    'pw',
    '--mfa',
    '123456',
    '--server-key',
    'k',
    '--register',
  ])
  assert.equal(flags.server, 'http://h:3001')
  assert.equal(flags.email, 'me@x.com')
  assert.equal(flags.password, 'pw')
  assert.equal(flags.mfa, '123456')
  assert.equal(flags['server-key'], 'k')
  assert.equal(flags.register, true)
})

test('--register does not swallow a following credential value', () => {
  const { flags } = parseArgs(['login', '--register', '--email', 'me@x.com'])
  assert.equal(flags.register, true)
  assert.equal(flags.email, 'me@x.com')
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
