import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

function repoRoot(): string {
  const cwd = process.cwd()
  if (existsSync(path.join(cwd, 'docker-compose.yml'))) {
    return cwd
  }
  if (existsSync(path.join(cwd, '..', 'docker-compose.yml'))) {
    return path.resolve(cwd, '..')
  }
  return cwd
}

export type RedisLoadResult = {
  workers: number
  opsPerWorker: number
  counterValue: number
  completedCommands: number
  durationMs: number
  commandsPerSecond: number
  usedMemoryBytes: number
}

const WORKER_SCRIPT = `
set -eu
prefix="$1"
worker="$2"
count="$3"
i=0
while [ "$i" -lt "$count" ]; do
  key="$prefix:$worker:$i"
  redis-cli --raw SET "$key" "$i" >/dev/null
  value="$(redis-cli --raw GET "$key")"
  if [ "$value" != "$i" ]; then
    echo "redis GET mismatch for $key: $value" >&2
    exit 17
  fi
  redis-cli --raw INCR "$prefix:counter" >/dev/null
  if [ $((i % 50)) -eq 0 ]; then
    redis-cli --raw EXPIRE "$key" 120 >/dev/null
  fi
  i=$((i + 1))
done
`

export async function redisParallelLoad(opts: {
  prefix: string
  workers: number
  opsPerWorker: number
  timeoutMs?: number
}): Promise<RedisLoadResult> {
  const workers = Math.max(1, opts.workers)
  const opsPerWorker = Math.max(1, opts.opsPerWorker)
  const timeoutMs = opts.timeoutMs ?? 120_000

  redisShell('redis-cli --raw SET "$1:counter" 0 >/dev/null && redis-cli --raw PING', [opts.prefix])

  const started = Date.now()
  try {
    await Promise.all(
      Array.from({ length: workers }, (_, index) =>
        runRedisWorker(opts.prefix, String(index + 1), String(opsPerWorker), timeoutMs),
      ),
    )

    const durationMs = Math.max(1, Date.now() - started)
    const counterValue = Number(redisShell('redis-cli --raw GET "$1:counter"', [opts.prefix]).trim())
    const usedMemoryBytes = Number(
      redisShell('redis-cli INFO memory | awk -F: \'/^used_memory:/ { gsub(/\\r/, "", $2); print $2; exit }\'').trim(),
    )
    const completedCommands = workers * opsPerWorker * 3

    return {
      workers,
      opsPerWorker,
      counterValue,
      completedCommands,
      durationMs,
      commandsPerSecond: Math.round(completedCommands / (durationMs / 1000)),
      usedMemoryBytes,
    }
  } finally {
    redisShell(
      'keys="$(redis-cli --scan --pattern "$1:*")"; if [ -n "$keys" ]; then printf "%s\\n" "$keys" | xargs redis-cli DEL >/dev/null; fi',
      [opts.prefix],
    )
  }
}

function redisShell(script: string, args: string[] = []): string {
  return execFileSync('docker', ['compose', 'exec', '-T', 'cache', 'sh', '-c', script, 'srn-redis-shell', ...args], {
    cwd: repoRoot(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  })
}

function runRedisWorker(prefix: string, worker: string, opsPerWorker: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'docker',
      ['compose', 'exec', '-T', 'cache', 'sh', '-c', WORKER_SCRIPT, 'srn-redis-worker', prefix, worker, opsPerWorker],
      {
        cwd: repoRoot(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    let stderr = ''
    let stdout = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`Redis worker ${worker} timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`Redis worker ${worker} failed with exit code ${code}\n${stdout}\n${stderr}`))
      }
    })
  })
}
