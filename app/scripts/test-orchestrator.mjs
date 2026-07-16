import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

export const DEFAULT_WORKSPACE_JOBS = 2
export const DEFAULT_JEST_WORKERS = 1

const MAX_EXPLICIT_CONCURRENCY = 128
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g

export function parsePositiveInteger(name, value, fallback) {
  if (value === undefined || value === '') {
    return fallback
  }

  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${name} must be a positive integer; received ${JSON.stringify(value)}`)
  }

  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed > MAX_EXPLICIT_CONCURRENCY) {
    throw new Error(`${name} must be between 1 and ${MAX_EXPLICIT_CONCURRENCY}; received ${JSON.stringify(value)}`)
  }

  return parsed
}

export function resolvePolicy(environment = process.env) {
  const workspaceJobs = parsePositiveInteger(
    'SRN_TEST_WORKSPACE_JOBS',
    environment.SRN_TEST_WORKSPACE_JOBS,
    DEFAULT_WORKSPACE_JOBS,
  )
  const jestWorkers = parsePositiveInteger(
    'SRN_TEST_JEST_WORKERS',
    environment.SRN_TEST_JEST_WORKERS,
    DEFAULT_JEST_WORKERS,
  )

  return {
    workspaceJobs,
    jestWorkers,
    peakJestWorkers: workspaceJobs * jestWorkers,
  }
}

export function classifyTestScript(script) {
  const trimmed = script.trim()
  if (/^jest(?:\s|$)/.test(trimmed)) {
    return 'jest'
  }

  if (/\bjest\b/.test(trimmed)) {
    throw new Error(`Unsupported compound Jest test script: ${JSON.stringify(script)}`)
  }

  return 'other'
}

export function parseWorkspaceList(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line))
    .filter((workspace) => workspace.location !== '.')
}

export function discoverTestWorkspaces(rootDirectory, workspaceEntries) {
  const discovered = workspaceEntries.flatMap((entry) => {
    const manifestPath = path.join(rootDirectory, entry.location, 'package.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    const testScript = manifest.scripts?.test

    if (typeof testScript !== 'string') {
      return []
    }
    if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
      throw new Error(`Test workspace at ${entry.location} has no package name`)
    }

    return [
      {
        name: manifest.name,
        location: entry.location,
        script: testScript,
        type: classifyTestScript(testScript),
        dependencyNames: Object.keys(manifest.dependencies ?? {}),
      },
    ]
  })

  const testWorkspaceNames = new Set(discovered.map((workspace) => workspace.name))
  return discovered
    .map((workspace) => ({
      ...workspace,
      dependencies: workspace.dependencyNames.filter((dependency) => testWorkspaceNames.has(dependency)),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

export function buildWorkspaceCommand(workspace, policy, yarnPath, nodePath = process.execPath) {
  const args = [yarnPath, 'workspace', workspace.name, 'run', 'test']
  if (workspace.type === 'jest') {
    args.push(`--maxWorkers=${policy.jestWorkers}`)
  }

  return { command: nodePath, args }
}

export async function runBoundedPlan(workspaces, workspaceJobs, runWorkspace) {
  const pending = new Map(workspaces.map((workspace) => [workspace.name, workspace]))
  const completed = new Set()
  const active = new Map()
  const results = []
  let failed = false

  while (pending.size > 0 || active.size > 0) {
    if (!failed) {
      const availableSlots = workspaceJobs - active.size
      const ready = [...pending.values()]
        .filter((workspace) => workspace.dependencies.every((dependency) => completed.has(dependency)))
        .slice(0, availableSlots)

      for (const workspace of ready) {
        pending.delete(workspace.name)
        const execution = Promise.resolve()
          .then(() => runWorkspace(workspace))
          .catch((error) => ({ exitCode: 1, error }))
          .then((result) => ({ workspace, result }))
        active.set(workspace.name, execution)
      }
    }

    if (active.size === 0) {
      if (!failed && pending.size > 0) {
        throw new Error(`Workspace test dependency cycle: ${[...pending.keys()].join(', ')}`)
      }
      break
    }

    const settled = await Promise.race(active.values())
    active.delete(settled.workspace.name)
    results.push({ workspace: settled.workspace, ...settled.result })

    if (settled.result.exitCode === 0) {
      completed.add(settled.workspace.name)
    } else {
      failed = true
    }
  }

  return {
    results,
    skipped: [...pending.values()],
  }
}

function parseJestCount(line, label) {
  const normalized = line.replace(ANSI_ESCAPE_PATTERN, '')
  if (!normalized.includes(`${label}:`)) {
    return undefined
  }

  const total = normalized.match(/(\d+)\s+total/)
  if (!total) {
    return undefined
  }

  return {
    total: Number(total[1]),
    passed: Number(normalized.match(/(\d+)\s+passed/)?.[1] ?? 0),
    failed: Number(normalized.match(/(\d+)\s+failed/)?.[1] ?? 0),
    skipped: Number(normalized.match(/(\d+)\s+skipped/)?.[1] ?? 0),
  }
}

function prefixOutput(stream, workspaceName, destination, summary) {
  const lines = createInterface({ input: stream })
  lines.on('line', (line) => {
    const suites = parseJestCount(line, 'Test Suites')
    const tests = parseJestCount(line, 'Tests')
    if (suites) {
      summary.suites = suites
    }
    if (tests) {
      summary.tests = tests
    }
    destination.write(`[${workspaceName}]: ${line}\n`)
  })
}

function runWorkspaceProcess(workspace, policy, rootDirectory, yarnPath) {
  const { command, args } = buildWorkspaceCommand(workspace, policy, yarnPath)
  const started = performance.now()
  const summary = {}
  console.log(
    `TEST_ORCHESTRATOR_START workspace=${workspace.name} type=${workspace.type} command=${JSON.stringify([command, ...args])}`,
  )

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: rootDirectory,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let spawnError

    prefixOutput(child.stdout, workspace.name, process.stdout, summary)
    prefixOutput(child.stderr, workspace.name, process.stderr, summary)
    child.on('error', (error) => {
      spawnError = error
    })
    child.on('close', (code, signal) => {
      const durationMs = Math.round(performance.now() - started)
      const exitCode = code ?? 1
      console.log(
        `TEST_ORCHESTRATOR_RESULT workspace=${workspace.name} exit=${exitCode} signal=${signal ?? 'none'} durationMs=${durationMs}`,
      )
      resolve({ exitCode, signal, durationMs, summary, error: spawnError })
    })
  })
}

function listWorkspaceEntries(rootDirectory, yarnPath) {
  const result = spawnSync(process.execPath, [yarnPath, 'workspaces', 'list', '--json'], {
    cwd: rootDirectory,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })
  if (result.status !== 0) {
    throw new Error(`Unable to list Yarn workspaces (exit ${result.status}):\n${result.stderr}`)
  }
  return parseWorkspaceList(result.stdout)
}

function aggregateCounts(results, key) {
  return results.reduce(
    (aggregate, result) => {
      const counts = result.summary?.[key]
      if (counts) {
        aggregate.total += counts.total
        aggregate.passed += counts.passed
        aggregate.failed += counts.failed
        aggregate.skipped += counts.skipped
      }
      return aggregate
    },
    { total: 0, passed: 0, failed: 0, skipped: 0 },
  )
}

async function main() {
  const scriptPath = fileURLToPath(import.meta.url)
  const rootDirectory = path.resolve(path.dirname(scriptPath), '..')
  const yarnPath = path.join(rootDirectory, '.yarn', 'releases', 'yarn-4.17.1.cjs')
  const policy = resolvePolicy()
  const workspaceEntries = listWorkspaceEntries(rootDirectory, yarnPath)
  const workspaces = discoverTestWorkspaces(rootDirectory, workspaceEntries)
  const jestWorkspaces = workspaces.filter((workspace) => workspace.type === 'jest').length
  const started = performance.now()

  console.log(
    `TEST_ORCHESTRATOR_POLICY workspaceJobs=${policy.workspaceJobs} jestWorkers=${policy.jestWorkers} peakJestWorkers=${policy.peakJestWorkers}`,
  )
  console.log(
    `TEST_ORCHESTRATOR_DISCOVERY workspaces=${workspaces.length} jest=${jestWorkspaces} other=${workspaces.length - jestWorkspaces}`,
  )

  const outcome = await runBoundedPlan(workspaces, policy.workspaceJobs, (workspace) =>
    runWorkspaceProcess(workspace, policy, rootDirectory, yarnPath),
  )
  const durationMs = Math.round(performance.now() - started)
  const passedWorkspaces = outcome.results.filter((result) => result.exitCode === 0).length
  const failedWorkspaces = outcome.results.filter((result) => result.exitCode !== 0)
  const suites = aggregateCounts(outcome.results, 'suites')
  const tests = aggregateCounts(outcome.results, 'tests')

  console.log(
    `TEST_ORCHESTRATOR_SUMMARY workspacesPassed=${passedWorkspaces} workspacesFailed=${failedWorkspaces.length} workspacesSkipped=${outcome.skipped.length} suitesPassed=${suites.passed} suitesFailed=${suites.failed} suitesSkipped=${suites.skipped} suitesTotal=${suites.total} testsPassed=${tests.passed} testsFailed=${tests.failed} testsSkipped=${tests.skipped} testsTotal=${tests.total} durationMs=${durationMs}`,
  )

  for (const result of failedWorkspaces) {
    console.error(`TEST_ORCHESTRATOR_FAILURE workspace=${result.workspace.name} exit=${result.exitCode}`)
    if (result.error) {
      console.error(result.error)
    }
  }
  for (const workspace of outcome.skipped) {
    console.error(`TEST_ORCHESTRATOR_SKIPPED workspace=${workspace.name}`)
  }

  if (failedWorkspaces.length > 0 || outcome.skipped.length > 0) {
    process.exitCode = 1
  }
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMainModule) {
  await main()
}
