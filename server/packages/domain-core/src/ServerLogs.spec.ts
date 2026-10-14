import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { normalizeLogTimestamp, parseServerLogLine, tailServerLogs, readServerLogTail } from './ServerLogs'

const fixture = (files: Record<string, string>) => ({
  readdir: async () => Object.keys(files),
  readFile: async (file: string) => files[path.basename(file)],
  joinPath: (...parts: string[]) => path.join(...parts),
})
describe('shared bounded server log view', () => {
  it('shows only validated closed sync progress metadata and excludes payloads or arbitrary labels', () => {
    const message = '[ws-sync] operation did not complete'
    expect(
      parseServerLogLine(
        JSON.stringify({
          message,
          operation: 'command',
          phase: 'backend-execute',
          outcome: 'timeout',
          elapsedMs: 123.5,
          authToken: 'never-display',
          request: { content: 'never-display' },
        }),
        'gateway',
      ).message,
    ).toBe(`${message} operation=command phase=backend-execute outcome=timeout elapsedMs=123.5`)
    expect(
      parseServerLogLine(
        JSON.stringify({
          message,
          operation: 'untrusted-token',
          phase: 'untrusted-token',
          outcome: 'untrusted-token',
          elapsedMs: -1,
        }),
        'gateway',
      ).message,
    ).toBe(message)
    expect(
      parseServerLogLine(
        JSON.stringify({
          message: 'other log',
          operation: 'command',
          phase: 'backend-execute',
          outcome: 'error',
          elapsedMs: 10,
        }),
        'gateway',
      ).message,
    ).toBe('other log')
  })
  it.each([
    ['2026-10-14T12:00:00+02:00', '2026-10-14T10:00:00.000Z'],
    [1720000000, '2024-07-03T09:46:40.000Z'],
    ['1720000000000', '2024-07-03T09:46:40.000Z'],
    [0, '1970-01-01T00:00:00.000Z'],
  ])('normalizes explicit ISO and epoch timestamps %s', (input, expected) => {
    expect(normalizeLogTimestamp(input)).toBe(expected)
  })
  it.each([
    undefined,
    null,
    {},
    '',
    -1,
    Infinity,
    1e20,
    '2026-02-31T00:00:00Z',
    '2026-10-14T24:00:00Z',
    '2026-10-14 12:00:00',
    '2026-10-14T00:00:00Z trailing',
  ])('leaves invalid or timezone-ambiguous timestamps unknown %s', (input) => {
    expect(normalizeLogTimestamp(input)).toBeNull()
  })
  it('parses plain capture envelopes and explicit severity overrides including stderr progress', () => {
    expect(parseServerLogLine('[2026-10-14T10:00:00Z] [auth] [stdout] Started on port3103', 'auth')).toEqual({
      timestamp: '2026-10-14T10:00:00.000Z',
      service: 'auth',
      level: 'info',
      message: 'Started on port3103',
    })
    expect(
      parseServerLogLine('[2026-10-14T10:00:00Z] [files] [stderr] [INFO] Waiting for database', 'files').level,
    ).toBe('info')
    expect(parseServerLogLine('2026-10-14T10:00:00Z warning: reconnecting', 'auth')).toMatchObject({
      level: 'warn',
      message: 'reconnecting',
    })
    expect(parseServerLogLine('unknown historical message', 'auth')).toEqual({
      timestamp: null,
      service: 'auth',
      level: null,
      message: 'unknown historical message',
    })
  })
  it('prefers valid structured metadata and retains real capture metadata when JSON is malformed', () => {
    const prefix = '[2026-10-14T10:00:00Z] [gateway] [stderr] '
    expect(
      parseServerLogLine(
        prefix + '{"timestamp":1720000000000,"level":2,"service":"auth","message":{"stage":"ready"}}',
        'gateway',
      ),
    ).toEqual({ timestamp: '2024-07-03T09:46:40.000Z', level: 'info', service: 'auth', message: '{"stage":"ready"}' })
    expect(
      parseServerLogLine(prefix + '{"timestamp":"invalid","level":999,"msg":"fallback"}', 'gateway'),
    ).toMatchObject({ timestamp: '2026-10-14T10:00:00.000Z', level: 'error', message: 'fallback' })
    expect(parseServerLogLine(prefix + '{broken', 'gateway')).toMatchObject({
      timestamp: '2026-10-14T10:00:00.000Z',
      message: '{broken',
    })
    expect(parseServerLogLine('{"time":1720000000,"level":40,"msg":"warning"}', 'auth').level).toBe('warn')
    expect(parseServerLogLine('[bad] [auth] [stdout] unchanged', 'auth').timestamp).toBeNull()
  })
  it('sorts all bounded matching timestamps before limiting and keeps unknown chronology explicit', async () => {
    const files = fixture({
      'z.log': [
        '{"timestamp":"2026-10-14T12:00:00Z","message":"newest"}',
        '{"timestamp":"2026-10-14T10:00:00Z","message":"older-after"}',
        'legacy1',
        'legacy2',
      ].join('\n'),
      'a.err': '{"timestamp":"2026-10-14T11:00:00Z","message":"middle"}',
    })
    const descending = await tailServerLogs(files, '/logs', { limit: 2 })
    expect(descending.entries.map((e) => e.message)).toEqual(['newest', 'middle'])
    expect(descending.truncated).toBe(true)
    expect((await tailServerLogs(files, '/logs', { limit: 5, order: 'asc' })).entries.map((e) => e.message)).toEqual([
      'older-after',
      'middle',
      'newest',
      'legacy1',
      'legacy2',
    ])
    expect((await tailServerLogs(files, '/logs', { limit: 5 })).entries.map((e) => e.message)).toEqual([
      'newest',
      'middle',
      'older-after',
      'legacy2',
      'legacy1',
    ])
  })
  it('selects the same newest matching subset before applying ascending display order', async () => {
    const files = fixture({
      'a.log': [5, 1, 4, 2, 3]
        .map((hour) => JSON.stringify({ timestamp: `2026-10-14T0${hour}:00:00Z`, message: `hour${hour}` }))
        .join('\n'),
      'b.err': '{"timestamp":"2026-10-14T04:30:00Z","message":"other-service"}',
    })
    const descending = await tailServerLogs(files, '/logs', { limit: 3 })
    const ascending = await tailServerLogs(files, '/logs', { limit: 3, order: 'asc' })
    expect(descending.entries.map((entry) => entry.message)).toEqual(['hour5', 'other-service', 'hour4'])
    expect(ascending.entries).toEqual([...descending.entries].reverse())
    expect(ascending.truncated).toBe(true)
  })
  it('applies service, level, literal search and inclusive since filters before limiting', async () => {
    const files = fixture({
      'combined.log': [
        '[2026-10-14T10:00:00Z] [auth] [stderr] [info] Database ready',
        '[2026-10-14T11:00:00Z] [auth] [stdout] database [ready]',
        '[2026-10-14T12:00:00Z] [files] [stdout] database ready',
        'legacy database [ready]',
      ].join('\n'),
    })
    expect(
      (
        await tailServerLogs(files, '/logs', {
          limit: 1,
          service: 'AUTH',
          level: 'INFO',
          search: '[READY]',
          since: '2026-10-14T11:00:00Z',
        })
      ).entries,
    ).toEqual([expect.objectContaining({ message: 'database [ready]', service: 'auth' })])
    expect((await tailServerLogs(files, '/logs', { limit: 1, search: 'does not exist' })).entries).toEqual([])
  })
  it('reports a truncated byte tail, skips unreadable files and tolerates an unavailable directory', async () => {
    const files = {
      ...fixture({}),
      readdir: async () => ['unreadable.err', 'ignored.log.1', 'auth.log'],
      readTail: async (file: string) => {
        if (file.endsWith('unreadable.err')) {
          throw Error('unreadable')
        }
        return { content: 'info: recent', truncated: true }
      },
    }
    expect(await tailServerLogs(files, '/logs', { limit: 10 })).toEqual({
      entries: [{ timestamp: null, service: 'auth', level: 'info', message: 'recent' }],
      truncated: true,
    })
    expect(
      await tailServerLogs(
        {
          ...files,
          readdir: async () => {
            throw Error('missing')
          },
        },
        '/logs',
        { limit: 10 },
      ),
    ).toEqual({ entries: [], truncated: false })
  })
  it('reads an actual file using a byte bound and discards its partial first line', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'srn-log-test-'))
    const file = path.join(directory, 'auth.log')
    try {
      await fs.writeFile(file, 'verylongoldline\nrecent\nlast\n')
      const tail = await readServerLogTail(file, 16)
      expect(tail).toEqual({ content: 'recent\nlast\n', truncated: true })
      expect((await readServerLogTail(file, 1024)).truncated).toBe(false)
    } finally {
      await fs.unlink(file)
      await fs.rmdir(directory)
    }
  })
  it('bounds injected full-file reads and clamps direct query limits', async () => {
    const files = fixture({ 'auth.log': 'x'.repeat(600000) + '\nnewest\n' })
    expect(await tailServerLogs(files, '/logs', { limit: NaN })).toEqual({
      entries: [{ timestamp: null, service: 'auth', level: null, message: 'newest' }],
      truncated: true,
    })
  })
})
