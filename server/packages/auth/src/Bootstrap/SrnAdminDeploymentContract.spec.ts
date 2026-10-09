import { readFileSync } from 'fs'
import { resolve } from 'path'

const repositoryRoot = resolve(__dirname, '../../../../..')
const readRepositoryFile = (path: string): string => readFileSync(resolve(repositoryRoot, path), 'utf8')
const occurrences = (text: string, value: string): number => text.split(value).length - 1

/**
 * Standard Red Notes: the two reasons `srn-admin` could not run a single
 * database command on a single container with auto-generated secrets, pinned
 * where each is actually decided.
 */
describe('srn-admin deployment contract', () => {
  describe('an empty environment value must not shadow the generated .env', () => {
    it('is still worth defending: both Compose topologies pass secrets as empty-defaulted', () => {
      const singleCompose = readRepositoryFile('docker-compose.single.yml')

      for (const secret of [
        'AUTH_JWT_SECRET',
        'JWT_SECRET',
        'ENCRYPTION_SERVER_KEY',
        'PSEUDO_KEY_PARAMS_KEY',
        'VALET_TOKEN_SECRET',
      ]) {
        expect(singleCompose).toContain(`${secret}: \${${secret}:-}`)
      }
    })

    it('and the single entrypoint is the only thing that fills them', () => {
      const entrypoint = readRepositoryFile('server/docker/single/entrypoint.sh')

      for (const secret of [
        'AUTH_JWT_SECRET',
        'JWT_SECRET',
        'ENCRYPTION_SERVER_KEY',
        'PSEUDO_KEY_PARAMS_KEY',
        'VALET_TOKEN_SECRET',
      ]) {
        expect(entrypoint).toContain(`put ${secret} "\${${secret}}"`)
      }
    })

    it('resolves a key the environment left empty from the loaded dotenv map', () => {
      const abstractEnv = readRepositoryFile('server/packages/domain-core/src/Domain/Env/AbstractEnv.ts')

      // The process environment is consulted first and only a NON-EMPTY value
      // short-circuits, so an operator-supplied value still wins.
      expect(abstractEnv).toContain('const fromEnvironment = process.env[key]')
      expect(abstractEnv).toContain("if (fromEnvironment !== undefined && fromEnvironment !== '') {")
      // ...and the file the package loaded is the fallback, not dead weight.
      expect(abstractEnv).toContain('const fromFile = this.env?.[key]')
      expect(abstractEnv).toContain("if (fromFile !== undefined && fromFile !== '') {")
      expect(abstractEnv).toContain('throw new Error(`Environment variable ${key} not set`)')
    })
  })

  describe("the CLI's publisher is chosen from the deployment, not from MODE", () => {
    const authContainer = (): string => readRepositoryFile('server/packages/auth/src/Bootstrap/Container.ts')

    it('selects it through the one reviewed decision in the cli arm', () => {
      const container = authContainer()

      expect(occurrences(container, 'selectCliDomainEventPublisher(')).toBe(1)
      expect(container).toContain("import { selectCliDomainEventPublisher } from './UndeliverableDomainEventPublisher'")
      // The decision is handed the deployment's topic ARN and a THUNK, so no SNS
      // client is constructed on a deployment that has no broker.
      expect(container).toMatch(
        /domainEventPublisher = selectCliDomainEventPublisher\(\s*env\.get\('SNS_TOPIC_ARN', true\),\s*\(\) =>/,
      )
    })

    it('leaves the direct-call and queued arms exactly as they were', () => {
      const container = authContainer()

      expect(container).toMatch(
        /if \(isConfiguredForHomeServer\) \{\s*domainEventPublisher = directCallDomainEventPublisher\s*\} else if \(isConfiguredForCli\) \{/,
      )
      expect(container).toContain(
        'domainEventPublisher = buildSnsDomainEventPublisher(\n        container.get(TYPES.Auth_SNS),',
      )
    })

    it('does not reach for MODE to make the decision', () => {
      const selection = readRepositoryFile('server/packages/auth/src/Bootstrap/UndeliverableDomainEventPublisher.ts')

      expect(selection).not.toContain("env.get('MODE'")
      expect(selection).not.toContain('home-server')
    })

    it('never projects MODE into a container environment', () => {
      // MODE is read in six containers; it stays a per-process statement that
      // HomeServer makes about itself.
      for (const path of ['docker-compose.single.yml', 'docker-compose.yml', 'server/docker/single/entrypoint.sh']) {
        const text = readRepositoryFile(path)
        expect(text).not.toMatch(/^\s*(put |export )?MODE[:=]/m)
      }
    })
  })

  describe('the role-change nudge is best-effort only for an unreachable transport', () => {
    it('tolerates exactly one typed condition and rethrows everything else', () => {
      const service = readRepositoryFile('server/packages/auth/src/Infra/WebSockets/WebSocketsClientService.ts')

      expect(service).toContain('if (!(error instanceof DomainEventTransportUnavailableError)) {')
      expect(service).toContain('throw error')
      expect(occurrences(service, 'catch (error)')).toBe(1)
    })

    it('leaves the publishes that CARRY work failing loudly', () => {
      const fixQuota = readRepositoryFile(
        'server/packages/auth/src/Domain/UseCase/FixStorageQuotaForUser/FixStorageQuotaForUser.ts',
      )
      const deleteAccount = readRepositoryFile('server/packages/auth/src/Domain/UseCase/DeleteAccount/DeleteAccount.ts')

      // No swallowing: neither use case may catch around its publish.
      expect(fixQuota).not.toContain('catch (')
      expect(deleteAccount).not.toContain('catch (')
    })
  })
})
