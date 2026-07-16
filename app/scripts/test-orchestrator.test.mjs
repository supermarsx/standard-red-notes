import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  DEFAULT_JEST_WORKERS,
  DEFAULT_WORKSPACE_JOBS,
  buildWorkspaceCommand,
  classifyTestScript,
  discoverTestWorkspaces,
  parsePositiveInteger,
  parseWorkspaceList,
  resolvePolicy,
  runBoundedPlan,
} from './test-orchestrator.mjs'

test('classifies direct Jest scripts without treating other test scripts as Jest', () => {
  assert.equal(classifyTestScript('jest'), 'jest')
  assert.equal(classifyTestScript('jest spec --coverage --passWithNoTests'), 'jest')
  assert.equal(classifyTestScript('yarn lint'), 'other')
  assert.throws(() => classifyTestScript('cross-env NODE_ENV=test jest'), /Unsupported compound Jest test script/)
})

test('resolves conservative defaults and explicit concurrency overrides', () => {
  assert.deepEqual(resolvePolicy({}), {
    workspaceJobs: DEFAULT_WORKSPACE_JOBS,
    jestWorkers: DEFAULT_JEST_WORKERS,
    peakJestWorkers: DEFAULT_WORKSPACE_JOBS * DEFAULT_JEST_WORKERS,
  })
  assert.deepEqual(resolvePolicy({ SRN_TEST_WORKSPACE_JOBS: '3', SRN_TEST_JEST_WORKERS: '4' }), {
    workspaceJobs: 3,
    jestWorkers: 4,
    peakJestWorkers: 12,
  })
  assert.equal(parsePositiveInteger('LIMIT', undefined, 2), 2)
  assert.throws(() => parsePositiveInteger('LIMIT', '0', 2), /positive integer/)
  assert.throws(() => parsePositiveInteger('LIMIT', '129', 2), /between 1 and 128/)
})

test('parses Yarn workspace output and discovers test command types and dependencies', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'srn-test-orchestrator-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, 'packages', 'base'), { recursive: true })
  await fs.mkdir(path.join(root, 'packages', 'consumer'), { recursive: true })
  await fs.mkdir(path.join(root, 'packages', 'lint-only'), { recursive: true })
  await fs.writeFile(
    path.join(root, 'packages', 'base', 'package.json'),
    JSON.stringify({ name: '@test/base', scripts: { test: 'jest' } }),
  )
  await fs.writeFile(
    path.join(root, 'packages', 'consumer', 'package.json'),
    JSON.stringify({
      name: '@test/consumer',
      scripts: { test: 'jest spec' },
      dependencies: { '@test/base': 'workspace:*' },
    }),
  )
  await fs.writeFile(
    path.join(root, 'packages', 'lint-only', 'package.json'),
    JSON.stringify({ name: '@test/lint-only', scripts: { test: 'yarn lint' } }),
  )

  const entries = parseWorkspaceList(
    '{"location":".","name":"root"}\n' +
      '{"location":"packages/base","name":"@test/base"}\n' +
      '{"location":"packages/consumer","name":"@test/consumer"}\n' +
      '{"location":"packages/lint-only","name":"@test/lint-only"}\n',
  )
  const workspaces = discoverTestWorkspaces(root, entries)

  assert.deepEqual(
    workspaces.map(({ name, type, dependencies }) => ({ name, type, dependencies })),
    [
      { name: '@test/base', type: 'jest', dependencies: [] },
      { name: '@test/consumer', type: 'jest', dependencies: ['@test/base'] },
      { name: '@test/lint-only', type: 'other', dependencies: [] },
    ],
  )
})

test('adds the worker cap only to direct Jest workspace commands', () => {
  const policy = { workspaceJobs: 2, jestWorkers: 3, peakJestWorkers: 6 }
  const jestCommand = buildWorkspaceCommand(
    { name: '@test/jest', type: 'jest' },
    policy,
    '/repo/.yarn/releases/yarn.cjs',
    '/node',
  )
  const otherCommand = buildWorkspaceCommand(
    { name: '@test/lint', type: 'other' },
    policy,
    '/repo/.yarn/releases/yarn.cjs',
    '/node',
  )

  assert.deepEqual(jestCommand, {
    command: '/node',
    args: ['/repo/.yarn/releases/yarn.cjs', 'workspace', '@test/jest', 'run', 'test', '--maxWorkers=3'],
  })
  assert.deepEqual(otherCommand, {
    command: '/node',
    args: ['/repo/.yarn/releases/yarn.cjs', 'workspace', '@test/lint', 'run', 'test'],
  })
})

test('bounds active workspaces and honors test dependency order', async () => {
  const workspaces = [
    { name: 'base', dependencies: [] },
    { name: 'consumer', dependencies: ['base'] },
    { name: 'independent', dependencies: [] },
  ]
  const events = []
  let active = 0
  let peak = 0

  const outcome = await runBoundedPlan(workspaces, 2, async (workspace) => {
    active += 1
    peak = Math.max(peak, active)
    events.push(`start:${workspace.name}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
    events.push(`end:${workspace.name}`)
    active -= 1
    return { exitCode: 0 }
  })

  assert.equal(peak, 2)
  assert.ok(events.indexOf('end:base') < events.indexOf('start:consumer'))
  assert.equal(outcome.results.length, 3)
  assert.deepEqual(outcome.skipped, [])
})

test('stops scheduling new workspaces after a failure', async () => {
  const started = []
  const outcome = await runBoundedPlan(
    [
      { name: 'failure', dependencies: [] },
      { name: 'dependent', dependencies: ['failure'] },
    ],
    1,
    async (workspace) => {
      started.push(workspace.name)
      return { exitCode: 1 }
    },
  )

  assert.deepEqual(started, ['failure'])
  assert.equal(outcome.results[0].exitCode, 1)
  assert.deepEqual(
    outcome.skipped.map((workspace) => workspace.name),
    ['dependent'],
  )
})
