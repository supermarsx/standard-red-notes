export abstract class AbstractEnv {
  protected env?: { [key: string]: string } = {}
  protected overrides: { [key: string]: string }

  constructor(overrides: { [key: string]: string } = {}) {
    this.overrides = overrides
  }

  abstract load(): void

  /**
   * Resolution order: constructor overrides, then `process.env`, then the
   * dotenv map `load()` parsed.
   *
   * Standard Red Notes: an EMPTY value does not count as set, at EITHER of the
   * last two steps, and that is the whole reason the dotenv map is consulted at
   * all. Both Compose topologies pass optional variables as `${FOO:-}`, so an
   * unset variable still arrives in the environment of every process in the
   * container as `FOO=""` — including a `docker exec`'d one. `dotenv.config()`
   * refuses to override a key that is already PRESENT in `process.env`, empty or
   * not, so the generated `.env` never filled those keys, and this method then
   * reported `Environment variable FOO not set` for a secret that was sitting in
   * the file two lines away. That is how `srn-admin` could not run a single
   * database command on a single container with auto-generated secrets.
   *
   * Reading the file as the LAST resort keeps the precedence an operator
   * expects: a value they actually set wins over the generated one. Only the
   * empty placeholder falls through, which is the one case where the
   * environment is saying "nothing here" rather than naming a value — this
   * class already treated it that way when deciding whether to throw.
   */
  get(key: string, optional = false): string {
    if (!this.env) {
      this.load()
    }

    if (this.overrides[key]) {
      return this.overrides[key]
    }

    const fromEnvironment = process.env[key]
    if (fromEnvironment !== undefined && fromEnvironment !== '') {
      return fromEnvironment
    }

    const fromFile = this.env?.[key]
    if (fromFile !== undefined && fromFile !== '') {
      return fromFile
    }

    if (!optional) {
      throw new Error(`Environment variable ${key} not set`)
    }

    return process.env[key] as string
  }

  getAll(): { [key: string]: string } {
    if (!this.env) {
      this.load()
    }

    return this.env as { [key: string]: string }
  }
}
