import 'reflect-metadata'

import {
  CLI_MANAGEABLE_FLAGS,
  findFlagSpec,
  formatBytes,
  formatTable,
  helpFor,
  matchGroupUuidInList,
  parseArgs,
  parseDateFilter,
  parseEnvFileContent,
  parseStorageLimitInput,
  resolveOperatorEnv,
  serviceProbeTargets,
  stringOption,
  tailLogFiles,
  usage,
  validateFlagValue,
  type LogFileSystemLike,
  type OperatorEnvSpec,
} from './SrnAdminCli'

describe('SrnAdminCli helpers', () => {
  describe('parseArgs', () => {
    it('should split positionals and options', () => {
      const parsed = parseArgs(['list', '--email', 'foo@bar.com', '--limit', '5', 'extra'])

      expect(parsed.positionals).toEqual(['list', 'extra'])
      expect(parsed.options).toEqual({ email: 'foo@bar.com', limit: '5' })
    })

    it('should support --key=value and boolean flags', () => {
      const parsed = parseArgs(['--sort=email', '--json', 'user@example.com'])

      expect(parsed.positionals).toEqual(['user@example.com'])
      expect(parsed.options).toEqual({ sort: 'email', json: true })
    })

    it('should not let a boolean flag swallow the next positional', () => {
      const parsed = parseArgs(['--json', 'someone@example.com'])

      expect(parsed.positionals).toEqual(['someone@example.com'])
      expect(parsed.options.json).toBe(true)
    })

    it('should degrade a value option with no value to true', () => {
      const parsed = parseArgs(['--reason'])

      expect(parsed.options.reason).toBe(true)
    })

    it('should treat an option followed by another option as boolean', () => {
      const parsed = parseArgs(['--banned', '--json'])

      expect(parsed.options.banned).toBe(true)
      expect(parsed.options.json).toBe(true)
    })
  })

  describe('stringOption', () => {
    it('should return trimmed values and undefined for booleans/empties', () => {
      expect(stringOption({ a: ' x ' }, 'a')).toEqual('x')
      expect(stringOption({ a: true }, 'a')).toBeUndefined()
      expect(stringOption({ a: '  ' }, 'a')).toBeUndefined()
      expect(stringOption({}, 'a')).toBeUndefined()
    })
  })

  describe('formatTable', () => {
    it('should align columns and include a divider', () => {
      const table = formatTable(
        ['NAME', 'VALUE'],
        [
          ['a', '1'],
          ['longer', '2'],
        ],
      )
      const lines = table.split('\n')

      expect(lines[0]).toEqual('NAME    VALUE')
      expect(lines[1]).toEqual('------  -----')
      expect(lines[2]).toEqual('a       1')
      expect(lines[3]).toEqual('longer  2')
    })

    it('should return an empty string for no rows', () => {
      expect(formatTable(['A'], [])).toEqual('')
    })
  })

  describe('formatBytes', () => {
    it('should format the files-server conventions', () => {
      expect(formatBytes(null)).toEqual('-')
      expect(formatBytes(-1)).toEqual('unlimited')
      expect(formatBytes(0)).toEqual('0 B')
      expect(formatBytes(1023)).toEqual('1023 B')
      expect(formatBytes(1024)).toEqual('1.0 KiB')
      expect(formatBytes(5 * 1024 * 1024 * 1024)).toEqual('5.0 GiB')
    })
  })

  describe('parseStorageLimitInput', () => {
    it('should accept bytes and the unlimited keyword', () => {
      expect(parseStorageLimitInput('unlimited')).toEqual({ ok: true, value: '-1' })
      expect(parseStorageLimitInput('-1')).toEqual({ ok: true, value: '-1' })
      expect(parseStorageLimitInput(' 5368709120 ')).toEqual({ ok: true, value: '5368709120' })
    })

    it('should reject invalid values like the admin controller does', () => {
      expect(parseStorageLimitInput('-2').ok).toBe(false)
      expect(parseStorageLimitInput('5GB').ok).toBe(false)
      expect(parseStorageLimitInput('1.5').ok).toBe(false)
      expect(parseStorageLimitInput('').ok).toBe(false)
    })
  })

  describe('flags allow-list', () => {
    it('should find specs case-insensitively and refuse unknown/sensitive settings', () => {
      expect(findFlagSpec('ai_enabled')?.name).toEqual('AI_ENABLED')
      expect(findFlagSpec('MFA_SECRET')).toBeUndefined()
      expect(findFlagSpec('NEXTCLOUD_BACKUP_APP_PASSWORD')).toBeUndefined()
      expect(findFlagSpec('LISTED_AUTHOR_SECRETS')).toBeUndefined()
    })

    it('should validate strict-boolean flags', () => {
      const spec = findFlagSpec('OCR_SERVER_ALLOWED') as NonNullable<ReturnType<typeof findFlagSpec>>

      expect(validateFlagValue(spec, 'true').ok).toBe(true)
      expect(validateFlagValue(spec, 'false').ok).toBe(true)
      expect(validateFlagValue(spec, 'yes').ok).toBe(false)
      expect(validateFlagValue(spec, null).ok).toBe(true)
    })

    it('should validate the email backup frequency', () => {
      const spec = findFlagSpec('EMAIL_BACKUP_FREQUENCY') as NonNullable<ReturnType<typeof findFlagSpec>>

      expect(validateFlagValue(spec, 'weekly').ok).toBe(true)
      expect(validateFlagValue(spec, 'hourly').ok).toBe(false)
    })

    it('should keep free-form flags free-form (mirrors the panel)', () => {
      const spec = findFlagSpec('AI_REQUEST_LIMIT') as NonNullable<ReturnType<typeof findFlagSpec>>

      expect(validateFlagValue(spec, 'anything').ok).toBe(true)
    })

    it('should mirror every panel-managed setting', () => {
      const names = CLI_MANAGEABLE_FLAGS.map((spec) => spec.name)
      for (const expected of [
        'AI_ENABLED',
        'AI_REQUEST_LIMIT',
        'EMAIL_BACKUP_FREQUENCY',
        'EMAIL_REMINDERS_ENABLED',
        'OCR_SERVER_ALLOWED',
        'NEXTCLOUD_BACKUP_ALLOWED',
        'NEXTCLOUD_BACKUP_FREQUENCY',
        'WORKFLOWS_ENABLED',
      ]) {
        expect(names).toContain(expected)
      }
    })
  })

  describe('tailLogFiles', () => {
    const fileSystemWith = (files: Record<string, string>): LogFileSystemLike => ({
      readdir: async () => Object.keys(files),
      readFile: async (filePath: string) => {
        const name = filePath.split('/').pop() as string
        if (files[name] === undefined) {
          throw new Error('missing')
        }

        return files[name]
      },
      joinPath: (...parts: string[]) => parts.join('/'),
    })

    it('should parse winston JSON lines and plain lines', async () => {
      const result = await tailLogFiles(
        fileSystemWith({
          'auth.log': [
            '{"level":"info","message":"hello","timestamp":"2026-01-01T00:00:00.000Z","service":"auth:server"}',
            'plain line',
          ].join('\n'),
        }),
        '/logs',
        { limit: 10 },
      )

      expect(result.entries).toHaveLength(2)
      const jsonEntry = result.entries.find((entry) => entry.message === 'hello')
      expect(jsonEntry?.level).toEqual('info')
      expect(jsonEntry?.service).toEqual('auth:server')
      const plainEntry = result.entries.find((entry) => entry.message === 'plain line')
      expect(plainEntry?.service).toEqual('auth')
      expect(plainEntry?.level).toBeNull()
    })

    it('should filter by service (file name) and level, keeping the last N matches', async () => {
      const lines = []
      for (let index = 0; index < 5; index++) {
        lines.push(`{"level":"error","message":"e${index}","timestamp":"2026-01-01T00:00:0${index}.000Z","service":"files"}`)
        lines.push(`{"level":"info","message":"i${index}","timestamp":"2026-01-01T00:00:0${index}.500Z","service":"files"}`)
      }
      const result = await tailLogFiles(
        fileSystemWith({ 'files.log': lines.join('\n'), 'auth.log': '{"level":"error","message":"other","service":"auth"}' }),
        '/logs',
        { limit: 3, service: 'files', level: 'error' },
      )

      expect(result.truncated).toBe(true)
      expect(result.entries.map((entry) => entry.message)).toEqual(['e4', 'e3', 'e2'])
    })

    it('should degrade to empty when the directory is unreadable', async () => {
      const fileSystem: LogFileSystemLike = {
        readdir: async () => {
          throw new Error('nope')
        },
        readFile: async () => '',
        joinPath: (...parts: string[]) => parts.join('/'),
      }

      expect(await tailLogFiles(fileSystem, '/nowhere', { limit: 5 })).toEqual({ entries: [], truncated: false })
    })

    it('should merge multiple files newest-first', async () => {
      const result = await tailLogFiles(
        fileSystemWith({
          'auth.log': '{"message":"older","timestamp":"2026-01-01T00:00:00.000Z","service":"auth"}',
          'files.err': '{"message":"newer","timestamp":"2026-01-02T00:00:00.000Z","service":"files"}',
        }),
        '/logs',
        { limit: 10 },
      )

      expect(result.entries.map((entry) => entry.message)).toEqual(['newer', 'older'])
    })
  })

  describe('parseEnvFileContent', () => {
    it('should parse KEY=VALUE lines, strip quotes and skip comments', () => {
      const parsed = parseEnvFileContent(
        ['# comment', '', 'PORT=3103', 'NAME="quoted value"', "OTHER='single'", 'BROKEN LINE', '=nokey'].join('\n'),
      )

      expect(parsed).toEqual({ PORT: '3103', NAME: 'quoted value', OTHER: 'single' })
    })
  })

  describe('resolveOperatorEnv', () => {
    const spec: OperatorEnvSpec = {
      env: 'WORKFLOWS_ENABLED',
      service: 'api-gateway',
      kind: 'boolean-loose',
      defaultValue: 'false',
      description: 'test',
      restartRequired: true,
    }

    it('should attribute operator-set envs to the operator', () => {
      const resolved = resolveOperatorEnv(
        spec,
        { API_GATEWAY_WORKFLOWS_ENABLED: 'yes' },
        { 'api-gateway': { WORKFLOWS_ENABLED: 'yes' } },
      )

      expect(resolved.effective).toEqual('on')
      expect(resolved.source).toEqual('operator env')
    })

    it('should attribute values only present in the package env to the entrypoint', () => {
      const resolved = resolveOperatorEnv(spec, {}, { 'api-gateway': { WORKFLOWS_ENABLED: 'true' } })

      expect(resolved.effective).toEqual('on')
      expect(resolved.source).toEqual('entrypoint default')
    })

    it('should fall back to the code default', () => {
      const resolved = resolveOperatorEnv(spec, {}, {})

      expect(resolved.effective).toEqual('off')
      expect(resolved.source).toEqual('code default')
    })

    it('should parse strict booleans strictly and redact secrets', () => {
      const strict: OperatorEnvSpec = { ...spec, env: 'NEXTCLOUD_BACKUPS_ENABLED', service: 'auth', kind: 'boolean-strict' }
      expect(resolveOperatorEnv(strict, {}, { auth: { NEXTCLOUD_BACKUPS_ENABLED: 'yes' } }).effective).toEqual('off')
      expect(resolveOperatorEnv(strict, {}, { auth: { NEXTCLOUD_BACKUPS_ENABLED: 'true' } }).effective).toEqual('on')

      const secret: OperatorEnvSpec = { ...spec, env: 'SMTP_PASS', service: 'auth', kind: 'string', redact: true }
      const resolved = resolveOperatorEnv(secret, {}, { auth: { SMTP_PASS: 'hunter2' } })
      expect(resolved.effective).toEqual('(set)')
      expect(resolved.raw).toEqual('(redacted)')
      expect(JSON.stringify(resolved)).not.toContain('hunter2')
    })

    it('should report unset strings honestly', () => {
      const url: OperatorEnvSpec = { ...spec, env: 'UPDATE_CHECK_URL', kind: 'string', defaultValue: null }

      expect(resolveOperatorEnv(url, {}, {}).effective).toEqual('(unset)')
    })
  })

  describe('serviceProbeTargets', () => {
    it('should use entrypoint ports with sane fallbacks', () => {
      const targets = serviceProbeTargets({ auth: { PORT: '4103' }, files: { PORT: 'not-a-number' } })

      expect(targets).toEqual([
        { name: 'api-gateway', port: 3000 },
        { name: 'syncing-server', port: 3101 },
        { name: 'auth', port: 4103 },
        { name: 'files', port: 3104 },
        { name: 'revisions', port: 3105 },
      ])
    })
  })

  describe('parseDateFilter', () => {
    it('should accept epoch milliseconds and ISO dates', () => {
      expect(parseDateFilter('1767225600000')).toEqual(1767225600000)
      expect(parseDateFilter('2026-01-01T00:00:00.000Z')).toEqual(Date.parse('2026-01-01T00:00:00.000Z'))
      expect(parseDateFilter('garbage')).toBeUndefined()
    })
  })

  describe('matchGroupUuidInList', () => {
    const groups = [
      { id: { toString: () => 'uuid-1' }, props: { name: 'Editors' } },
      { id: { toString: () => 'uuid-2' }, props: { name: 'editors' } },
      { id: { toString: () => 'uuid-3' }, props: { name: 'Admins' } },
    ]

    it('should prefer a uuid match when the identifier is a uuid', () => {
      expect(matchGroupUuidInList(groups, 'uuid-3', true)).toEqual('uuid-3')
    })

    it('should match a name case-sensitively first', () => {
      expect(matchGroupUuidInList(groups, 'Editors', false)).toEqual('uuid-1')
    })

    it('should fall back to a unique case-insensitive match', () => {
      expect(matchGroupUuidInList(groups, 'ADMINS', false)).toEqual('uuid-3')
    })

    it('should throw for ambiguous and missing names', () => {
      expect(() => matchGroupUuidInList(groups, 'EDITORS', false)).toThrow(/ambiguous/)
      expect(() => matchGroupUuidInList(groups, 'nope', false)).toThrow(/no group found/)
    })
  })

  describe('help', () => {
    it('should group the command tree', () => {
      const text = usage()
      for (const group of ['USERS', 'ROLES & GROUPS', 'FLAGS', 'SERVER', 'DIAGNOSTICS']) {
        expect(text).toContain(group)
      }
    })

    it('should provide per-command help with alias fallbacks', () => {
      expect(helpFor('users', 'list')).toContain('users list')
      expect(helpFor('whois')).toContain('rich whois')
      expect(helpFor('grant-admin')).toContain('roles grant')
      expect(helpFor('registration')).toContain('PERSISTED')
      expect(helpFor('config')).toContain('read-only')
      expect(helpFor('unknown-topic')).toEqual(usage())
      expect(helpFor(undefined)).toEqual(usage())
    })
  })
})
