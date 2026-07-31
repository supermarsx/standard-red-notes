import { existsSync, readFileSync } from 'fs'
import * as path from 'path'

function composeService(compose: string, serviceName: string): string {
  const marker = `\n  ${serviceName}:`
  const start = compose.indexOf(marker)
  if (start < 0) {
    throw new Error(`Compose service not found: ${serviceName}`)
  }
  const nextService = compose.slice(start + marker.length).search(/\n  [a-zA-Z0-9_-]+:/)
  return nextService < 0 ? compose.slice(start) : compose.slice(start, start + marker.length + nextService)
}

function serviceNetworks(service: string): string[] {
  const networks = /\n    networks:\n((?:      .*(?:\r?\n|$))*)/.exec(service)?.[1] ?? ''
  return [...networks.matchAll(/^      - ([a-zA-Z0-9_-]+)\s*$/gm)].map((match) => match[1])
}

describe('workflows external-origin boundary', () => {
  const packageRoot = path.resolve(__dirname, '..', '..')
  const repositoryRoot = path.resolve(packageRoot, '..', '..', '..')

  it('does not ship the retired n8n reverse proxy or pairing store', () => {
    expect(existsSync(path.join(packageRoot, 'src/Workflows/registerWorkflowsUiProxy.ts'))).toBe(false)
    expect(existsSync(path.join(packageRoot, 'src/Service/Workflows/WorkflowsPairingStore.ts'))).toBe(false)
  })

  it('does not mount, export, or log an embedded workflows UI route', () => {
    const productionSources = [
      path.join(packageRoot, 'bin/server.ts'),
      path.join(packageRoot, 'src/Bootstrap/Container.ts'),
      path.join(packageRoot, 'src/Workflows/index.ts'),
      path.join(packageRoot, '..', 'home-server/src/Server/HomeServer.ts'),
      path.join(repositoryRoot, 'app/docker/nginx.conf'),
      path.join(repositoryRoot, 'app/docker/single/nginx.conf'),
      path.join(repositoryRoot, 'docker-compose.yml'),
    ]
      .map((filePath) => readFileSync(filePath, 'utf8'))
      .join('\n')

    expect(productionSources).not.toMatch(/registerWorkflowsUiProxy/)
    expect(productionSources).not.toMatch(/WorkflowsPairingStore/)
    expect(productionSources).not.toMatch(/\/workflows-ui(?:\/|\b)/)
  })

  it('exposes status discovery only, with no pairing mutation route', () => {
    const controller = readFileSync(path.join(packageRoot, 'src/Controller/v1/WorkflowsController.ts'), 'utf8')

    expect(controller).toContain("@httpGet('/status'")
    expect(controller).not.toMatch(/@httpPost\(/)
    expect(controller).not.toMatch(/['"`]\/(?:un)?pair['"`]/)
  })

  it('keeps the optional n8n container isolated and hardened by default', () => {
    const compose = readFileSync(path.join(repositoryRoot, 'docker-compose.yml'), 'utf8')
    const n8nService = composeService(compose, 'n8n')
    const mcpService = composeService(compose, 'mcp')

    expect(n8nService).toContain('${N8N_BIND_ADDRESS:-127.0.0.1}:${N8N_PORT:-5678}:5678')
    expect(n8nService).toContain('N8N_LISTEN_ADDRESS: ${N8N_LISTEN_ADDRESS:-0.0.0.0}')
    expect(n8nService).toContain(
      'N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS: ${N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS:-true}',
    )
    expect(n8nService).toContain('N8N_BLOCK_ENV_ACCESS_IN_NODE: ${N8N_BLOCK_ENV_ACCESS_IN_NODE:-true}')
    expect(n8nService).toContain('N8N_BLOCK_FILE_ACCESS_TO_N8N_FILES: ${N8N_BLOCK_FILE_ACCESS_TO_N8N_FILES:-true}')
    expect(n8nService).toContain('N8N_RESTRICT_FILE_ACCESS_TO: ${N8N_RESTRICT_FILE_ACCESS_TO:-/home/node/.n8n-files}')
    expect(n8nService).toContain('N8N_DIAGNOSTICS_ENABLED: ${N8N_DIAGNOSTICS_ENABLED:-false}')
    expect(n8nService).toContain('N8N_PERSONALIZATION_ENABLED: ${N8N_PERSONALIZATION_ENABLED:-false}')
    expect(n8nService).toContain('N8N_COMMUNITY_PACKAGES_ENABLED: ${N8N_COMMUNITY_PACKAGES_ENABLED:-false}')
    expect(n8nService).toContain('N8N_PUBLIC_API_DISABLED: ${N8N_PUBLIC_API_DISABLED:-true}')
    expect(n8nService).toContain('N8N_PUBLIC_API_SWAGGERUI_DISABLED: ${N8N_PUBLIC_API_SWAGGERUI_DISABLED:-true}')
    expect(n8nService).not.toMatch(/N8N_PATH:\s*\/workflows-ui/)
    expect(serviceNetworks(n8nService)).toEqual(['workflows-mcp'])
    expect(serviceNetworks(mcpService)).toEqual(['standard-red-notes', 'workflows-mcp'])

    for (const coreService of ['app', 'server', 'db', 'cache', 'floci', 'docker-socket-proxy']) {
      expect(serviceNetworks(composeService(compose, coreService))).not.toContain('workflows-mcp')
    }
    expect(compose).toMatch(/\n  workflows-mcp:\r?\n    driver: bridge/)
  })

  it('requires raw Compose callers to provide the canonical app origin', () => {
    const multiCompose = readFileSync(path.join(repositoryRoot, 'docker-compose.yml'), 'utf8')
    const singleCompose = readFileSync(path.join(repositoryRoot, 'docker-compose.single.yml'), 'utf8')

    expect(multiCompose).toContain('PUBLIC_URL: ${PUBLIC_URL:-}')
    expect(singleCompose).toContain('PUBLIC_URL: ${PUBLIC_URL:-}')
    expect(multiCompose).not.toMatch(/PUBLIC_URL:\s*\$\{PUBLIC_URL:-https?:\/\/localhost/)
    expect(singleCompose).not.toMatch(/PUBLIC_URL:\s*\$\{PUBLIC_URL:-https?:\/\/localhost/)
  })

  it('persists the configured app origin in both generated environment files', () => {
    const shellSetup = readFileSync(path.join(repositoryRoot, 'scripts/setup.sh'), 'utf8')
    const powershellSetup = readFileSync(path.join(repositoryRoot, 'scripts/setup.ps1'), 'utf8')

    expect(shellSetup).toContain('PUBLIC_URL=${PUBLIC_URL}')
    expect(shellSetup).toContain('APP_URL="${PUBLIC_URL}"')
    expect(powershellSetup).toContain('PUBLIC_URL=$PublicUrl')
    expect(powershellSetup).toContain('$AppUrl = $PublicUrl')
  })
})
