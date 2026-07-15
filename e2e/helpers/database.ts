import { execFileSync } from 'node:child_process'
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

export function sqlString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
}

export function dbQueryJson<T extends Record<string, unknown>>(sql: string): T[] {
  const output = execFileSync(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      'db',
      'sh',
      '-c',
      'exec mariadb -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE" --batch --raw --skip-column-names',
    ],
    {
      cwd: repoRoot(),
      input: sql,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  ).trim()

  if (!output) {
    return []
  }

  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T)
}
