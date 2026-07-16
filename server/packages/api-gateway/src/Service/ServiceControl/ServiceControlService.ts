import { execFile } from 'child_process'

/**
 * Standard Red Notes: the three lifecycle actions the admin panel can drive on a
 * supervisord-managed program.
 */
export type ServiceAction = 'restart' | 'stop' | 'start'

export const SERVICE_ACTIONS: ServiceAction[] = ['restart', 'stop', 'start']

/**
 * The api-gateway program is SPECIAL: it is the process serving the admin
 * request. Stopping it kills the responder outright; restarting it drops the
 * admin's connection for a few seconds. We forbid `stop` of the gateway and only
 * allow `restart` when the caller explicitly confirms the self-interrupt.
 */
export const API_GATEWAY_PROGRAM = 'api-gateway'

/**
 * Standard Red Notes: the exact set of supervisord program names the admin panel
 * may control. This is an ALLOWLIST — the single defense against command
 * injection: a `:name` path segment that is not an exact member is rejected
 * before any process is spawned, and program names are only ever passed to
 * `supervisorctl` as a discrete argv element (never interpolated into a shell).
 * Mirrors the [program:*] blocks in server/docker/supervisord.conf.
 */
export const DEFAULT_CONTROLLABLE_PROGRAMS: string[] = [
  'syncing-server',
  'syncing-server-worker',
  'auth',
  'auth-worker',
  'files',
  'files-worker',
  'revisions',
  'revisions-worker',
  API_GATEWAY_PROGRAM,
]

/**
 * Discriminated outcome of a control attempt. The controller maps each `kind`
 * onto an HTTP status; the service itself NEVER throws so an unavailable or
 * misbehaving supervisorctl degrades to a clear result instead of a 500.
 */
export type ServiceControlOutcome =
  | { kind: 'ok'; program: string; action: ServiceAction; status: string }
  | { kind: 'invalid-program'; program: string }
  | { kind: 'forbidden'; program: string; action: ServiceAction; reason: string; requiresConfirmation?: boolean }
  | { kind: 'unavailable'; message: string }
  | { kind: 'error'; program: string; action: ServiceAction; message: string }

/**
 * Result of running the supervisorctl binary once. `error` is set when the
 * process could not be spawned (e.g. binary missing on an older image).
 */
export interface SupervisorctlRunResult {
  stdout: string
  stderr: string
  code: number | null
  error?: Error
}

/**
 * Injection seam: runs supervisorctl with the given argv (already including the
 * `-c <config>` prefix). Kept abstract so the service is unit-testable without a
 * real supervisord, and so the ONLY place a real process is spawned uses
 * execFile (argv array, no shell) — user input can never reach a shell.
 */
export type SupervisorctlRunner = (args: string[]) => Promise<SupervisorctlRunResult>

export interface ServiceControlServiceOptions {
  controllablePrograms?: string[]
  configPath?: string
  runner?: SupervisorctlRunner
  timeoutMs?: number
}

/**
 * Standard Red Notes: shells out to `supervisorctl` to restart/stop/start the
 * sibling server processes running under supervisord in the single-container
 * image (see server/docker/supervisord.conf). Backs the admin panel's Service
 * lifecycle controls.
 *
 * SAFETY:
 *   - Allowlist: only the exact program names in `controllablePrograms` are ever
 *     acted on; anything else short-circuits to `invalid-program` with no spawn.
 *   - No shell: the program name is passed as a discrete argv element to
 *     execFile, so metacharacters in a (rejected-anyway) name cannot inject.
 *   - api-gateway guard: `stop` is forbidden; `restart` requires an explicit
 *     self-interrupt confirmation (the controller sends the HTTP response BEFORE
 *     firing that restart, since it drops this connection).
 *   - Fail-soft: a missing/misconfigured supervisorctl (older image without the
 *     [supervisorctl] socket sections) degrades to `unavailable`, never a 500.
 */
export class ServiceControlService {
  private readonly controllablePrograms: string[]
  private readonly configPath: string
  private readonly runner: SupervisorctlRunner
  private readonly timeoutMs: number

  constructor(options: ServiceControlServiceOptions = {}) {
    this.controllablePrograms = options.controllablePrograms ?? DEFAULT_CONTROLLABLE_PROGRAMS
    this.configPath = options.configPath ?? '/etc/supervisord.conf'
    this.timeoutMs = options.timeoutMs ?? 15_000
    this.runner = options.runner ?? this.defaultRunner()
  }

  /** The allowlisted program names the UI may render controls for. */
  getControllablePrograms(): string[] {
    return [...this.controllablePrograms]
  }

  isControllable(program: string): boolean {
    return this.controllablePrograms.includes(program)
  }

  /**
   * Probe whether supervisorctl can actually talk to supervisord (returns false
   * on an older image whose conf lacks the [supervisorctl] socket sections). Used
   * by the GET /services endpoint so the UI can decide whether to show controls.
   */
  async isAvailable(): Promise<boolean> {
    const result = await this.safeRun(['status'])
    if (result.error) {
      return false
    }
    // `status` exits non-zero when some programs are not RUNNING, which is still
    // a working control channel. Only a genuine connection/config failure counts
    // as unavailable.
    return !this.looksUnavailable(result)
  }

  /**
   * Run one lifecycle action against one program. Enforces the allowlist and the
   * api-gateway guard, then shells out to supervisorctl and reads back the new
   * status. Never throws.
   */
  async control(
    program: string,
    action: ServiceAction,
    options: { confirmSelfInterrupt?: boolean } = {},
  ): Promise<ServiceControlOutcome> {
    if (!this.isControllable(program)) {
      return { kind: 'invalid-program', program }
    }

    if (program === API_GATEWAY_PROGRAM) {
      if (action === 'stop') {
        return {
          kind: 'forbidden',
          program,
          action,
          reason:
            'Stopping the API gateway would kill the process serving this request and take the whole server offline. Use restart instead.',
        }
      }
      if (action === 'restart' && !options.confirmSelfInterrupt) {
        return {
          kind: 'forbidden',
          program,
          action,
          requiresConfirmation: true,
          reason:
            'Restarting the API gateway will drop your admin connection for a few seconds. Retry with confirmSelfInterrupt=true to proceed.',
        }
      }
    }

    const run = await this.safeRun([action, program])
    if (this.looksUnavailable(run)) {
      return { kind: 'unavailable', message: this.unavailableMessage(run) }
    }
    if (run.error || run.code !== 0) {
      return {
        kind: 'error',
        program,
        action,
        message: this.firstMeaningfulLine(run) || `supervisorctl ${action} ${program} failed.`,
      }
    }

    // Read back the new state so the response reflects reality even if the UI
    // does not immediately re-poll server-status.
    const status = await this.readStatus(program)

    return { kind: 'ok', program, action, status }
  }

  /** Parsed supervisord state (RUNNING/STOPPED/STARTING/FATAL/…) for a program. */
  private async readStatus(program: string): Promise<string> {
    const run = await this.safeRun(['status', program])
    if (this.looksUnavailable(run) || run.error) {
      return 'unknown'
    }
    // e.g. "auth                             RUNNING   pid 42, uptime 0:05:12"
    const line = (run.stdout || '').split(/\r?\n/).find((entry) => entry.trim().startsWith(program))
    if (!line) {
      return 'unknown'
    }
    const parts = line.trim().split(/\s+/)

    return parts[1] ?? 'unknown'
  }

  private async safeRun(args: string[]): Promise<SupervisorctlRunResult> {
    try {
      return await this.runner(['-c', this.configPath, ...args])
    } catch (error) {
      return { stdout: '', stderr: '', code: null, error: error as Error }
    }
  }

  /**
   * Distinguish "supervisorctl cannot reach supervisord" (unavailable — degrade
   * gracefully) from "the command ran but the action failed" (a real error).
   */
  private looksUnavailable(result: SupervisorctlRunResult): boolean {
    if (result.error) {
      // ENOENT (binary missing) or a spawn failure => unavailable.
      return true
    }
    const haystack = `${result.stdout}\n${result.stderr}`.toLowerCase()

    const markers = [
      'does not include supervisorctl section',
      'no such file',
      'refused connection',
      'connection refused',
      'could not find config file',
    ]
    if (markers.some((marker) => haystack.includes(marker))) {
      return true
    }

    // A socket error surfaces as an "error: ..." line mentioning the sock file.
    return haystack.includes('error:') && haystack.includes('sock')
  }

  private unavailableMessage(result: SupervisorctlRunResult): string {
    if (result.error && (result.error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return 'supervisorctl is not installed in this container image.'
    }

    return 'Service control is not available on this server (supervisorctl cannot reach supervisord). A newer server image is required.'
  }

  private firstMeaningfulLine(result: SupervisorctlRunResult): string {
    const combined = `${result.stderr}\n${result.stdout}`
    const line = combined
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find((entry) => entry.length > 0)

    return line ?? ''
  }

  private defaultRunner(): SupervisorctlRunner {
    return (args: string[]) =>
      new Promise<SupervisorctlRunResult>((resolve) => {
        execFile('supervisorctl', args, { timeout: this.timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
          const code =
            error && typeof (error as NodeJS.ErrnoException & { code?: number }).code === 'number'
              ? ((error as unknown as { code: number }).code as number)
              : error
                ? 1
                : 0
          resolve({
            stdout: stdout?.toString() ?? '',
            stderr: stderr?.toString() ?? '',
            code,
            // Only treat a genuine spawn failure (ENOENT etc.) as `error`; a
            // non-zero EXIT is normal for supervisorctl and is carried via
            // `code`, not `error`.
            error: error && (error as NodeJS.ErrnoException).code === 'ENOENT' ? error : undefined,
          })
        })
      })
  }
}
