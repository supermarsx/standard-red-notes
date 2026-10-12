import { promises as fs } from 'fs'
import * as path from 'path'

import {
  isDavBridgeModeName,
  isDavBridgeOriginList,
  isExactHttpOrigin,
  ServerSettingsStore,
} from '../ServerSettings/ServerSettingsStore'
import { readDavBridgeBoolean, readDavBridgeEnvironment } from './DavBridgeFactory'
import { DavBridgeRefusal } from './DavBridgeRefusal'
import { DavBridgeEnvBaseline, DavBridgeSettings, parseDavBridgeOriginList } from './DavBridgeSettings'
import { removeDirectory, temporaryDirectory, TEST_SERVER_KEY } from './DavBridgeTestKit.spec'

describe('DavBridgeSettings', () => {
  let directory: string
  let settingsPath: string
  let store: ServerSettingsStore

  const settings = (env: Partial<DavBridgeEnvBaseline> = {}): DavBridgeSettings =>
    new DavBridgeSettings(store, { allowlistEnvOnly: false, ...env })

  beforeEach(async () => {
    directory = await temporaryDirectory('settings')
    settingsPath = path.join(directory, 'server-settings.json')
    store = new ServerSettingsStore(settingsPath, TEST_SERVER_KEY)
  })

  afterEach(async () => {
    await removeDirectory(directory)
  })

  it('is off, in relay mode, for nobody, with no private origins and five accounts, by default', async () => {
    expect(await settings().resolve()).toEqual({
      enabled: false,
      mode: 'relay',
      modeImplemented: true,
      allowAllUsers: false,
      allowedPrivateOrigins: [],
      maxAccountsPerUser: 5,
      allowlistEnvOnly: false,
    })
    expect((await settings().view()).sources).toEqual({
      enabled: 'default',
      mode: 'default',
      allowAllUsers: 'default',
      allowedPrivateOrigins: 'default',
      maxAccountsPerUser: 'default',
    })
  })

  it('takes the environment over the default', async () => {
    const view = await settings({
      enabled: true,
      allowAllUsers: true,
      allowedPrivateOrigins: ['http://nextcloud'],
      maxAccountsPerUser: 9,
    }).view()

    expect(view.settings).toEqual({
      enabled: true,
      mode: 'relay',
      allowAllUsers: true,
      allowedPrivateOrigins: ['http://nextcloud'],
      maxAccountsPerUser: 9,
    })
    expect(view.sources).toEqual({
      enabled: 'env',
      mode: 'default',
      allowAllUsers: 'env',
      allowedPrivateOrigins: 'env',
      maxAccountsPerUser: 'env',
    })
  })

  it('takes what the administrator saved over the environment, key by key', async () => {
    const bridge = settings({ enabled: true, allowedPrivateOrigins: ['http://from-env'], maxAccountsPerUser: 9 })

    await bridge.applyPatch({ enabled: false, allowedPrivateOrigins: ['https://cloud.home.lan:8443'] })

    const view = await bridge.view()
    expect(view.settings).toMatchObject({
      enabled: false,
      allowedPrivateOrigins: ['https://cloud.home.lan:8443'],
      maxAccountsPerUser: 9,
    })
    expect(view.sources).toMatchObject({
      enabled: 'persisted',
      allowedPrivateOrigins: 'persisted',
      maxAccountsPerUser: 'env',
    })
  })

  it('is a kill switch: saving enabled=false takes effect on the next read with no restart', async () => {
    const bridge = settings({ enabled: true })
    expect((await bridge.resolve()).enabled).toBe(true)

    await bridge.applyPatch({ enabled: false })

    expect((await bridge.resolve()).enabled).toBe(false)
    // A second process reading the same file sees it too.
    expect(
      (
        await new DavBridgeSettings(new ServerSettingsStore(settingsPath, TEST_SERVER_KEY), {
          enabled: true,
          allowlistEnvOnly: false,
        }).resolve()
      ).enabled,
    ).toBe(false)
  })

  it('clears an override with null and falls back to the environment', async () => {
    const bridge = settings({ enabled: true, allowedPrivateOrigins: ['http://from-env'] })
    await bridge.applyPatch({ enabled: false, allowedPrivateOrigins: [] })
    expect((await bridge.resolve()).allowedPrivateOrigins).toEqual([])

    await bridge.applyPatch({ enabled: null, allowedPrivateOrigins: null })

    expect(await bridge.resolve()).toMatchObject({ enabled: true, allowedPrivateOrigins: ['http://from-env'] })
    expect(JSON.parse(await fs.readFile(settingsPath, 'utf8'))).toEqual({})
  })

  it('distinguishes an empty saved list (allow nothing) from no saved list (use the environment)', async () => {
    const bridge = settings({ allowedPrivateOrigins: ['http://from-env'] })

    await bridge.applyPatch({ allowedPrivateOrigins: [] })

    expect((await bridge.view()).settings.allowedPrivateOrigins).toEqual([])
    expect((await bridge.view()).sources.allowedPrivateOrigins).toBe('persisted')
  })

  it('leaves every other section of the settings file alone', async () => {
    await store.update({ plugins: { sameOriginRendering: true }, ocr: { maxPages: 7 } })

    await settings().applyPatch({ enabled: true })

    expect(await store.read()).toEqual({
      plugins: { sameOriginRendering: true },
      ocr: { maxPages: 7 },
      davBridge: { enabled: true },
    })
  })

  describe('an unreadable settings file', () => {
    it('makes the bridge REFUSE rather than fall back to an environment that says on', async () => {
      const bridge = settings({ enabled: true, allowAllUsers: true, allowedPrivateOrigins: ['http://nextcloud'] })
      await bridge.applyPatch({ enabled: false })
      // The positive control: before the damage the saved "off" is what is read.
      expect((await bridge.resolve()).enabled).toBe(false)

      await fs.writeFile(settingsPath, '{ this is not json', 'utf8')

      let caught: unknown
      try {
        await bridge.resolve()
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(DavBridgeRefusal)
      expect(caught).toMatchObject({ tag: 'dav-settings-unavailable', httpStatus: 503 })
      await expect(bridge.view()).rejects.toMatchObject({ tag: 'dav-settings-unavailable' })
    })

    it('does the same for a file whose shape is not valid', async () => {
      await fs.writeFile(settingsPath, JSON.stringify({ davBridge: { enabled: 'yes' } }), 'utf8')

      await expect(settings({ enabled: true }).resolve()).rejects.toMatchObject({ tag: 'dav-settings-unavailable' })
    })
  })

  describe('mode', () => {
    it('implements relay', async () => {
      const view = await settings({ mode: 'relay' }).view()

      expect(view.modes).toEqual(['relay'])
      expect(view.modeImplemented).toBe(true)
      expect(view.sources.mode).toBe('env')
    })

    it('reports a mode this build does not implement instead of quietly running as relay', async () => {
      const fromEnv = await settings({ mode: 'hub' }).resolve()

      expect(fromEnv.mode).toBe('hub')
      expect(fromEnv.modeImplemented).toBe(false)
    })

    it('still loads a settings file written with a mode it does not know, and every other setting with it', async () => {
      await fs.writeFile(
        settingsPath,
        JSON.stringify({ davBridge: { enabled: true, mode: 'hub' }, plugins: { sameOriginRendering: true } }),
        'utf8',
      )

      const resolved = await settings().resolve()

      expect(resolved).toMatchObject({ enabled: true, mode: 'hub', modeImplemented: false })
      // The rest of the file is still readable: an unknown mode did not brick it.
      expect((await store.read()).plugins).toEqual({ sameOriginRendering: true })
    })
  })

  describe('the allowed-origin list pinned to the environment', () => {
    it('refuses to save a list, and ignores one saved before it was pinned', async () => {
      await settings().applyPatch({ allowedPrivateOrigins: ['http://saved-earlier'] })
      const pinned = settings({ allowlistEnvOnly: true, allowedPrivateOrigins: ['http://from-env'] })

      await expect(pinned.applyPatch({ allowedPrivateOrigins: ['http://attacker.lan'] })).rejects.toMatchObject({
        tag: 'dav-allowlist-env-only',
        httpStatus: 409,
      })
      await expect(pinned.applyPatch({ allowedPrivateOrigins: null })).rejects.toMatchObject({
        tag: 'dav-allowlist-env-only',
      })

      const view = await pinned.view()
      expect(view.allowlistEditable).toBe(false)
      expect(view.settings.allowedPrivateOrigins).toEqual(['http://from-env'])
      expect(view.sources.allowedPrivateOrigins).toBe('env')
    })

    it('with no environment list either, allows nothing', async () => {
      await settings().applyPatch({ allowedPrivateOrigins: ['http://saved-earlier'] })

      expect((await settings({ allowlistEnvOnly: true }).resolve()).allowedPrivateOrigins).toEqual([])
    })

    it('still lets the other settings be saved', async () => {
      const pinned = settings({ allowlistEnvOnly: true })

      await pinned.applyPatch({ enabled: true, maxAccountsPerUser: 3 })

      expect(await pinned.resolve()).toMatchObject({ enabled: true, maxAccountsPerUser: 3 })
    })
  })

  it('ignores an environment account limit that is out of range', async () => {
    for (const limit of [0, 21, -1, 2.5, Number.NaN]) {
      expect((await settings({ maxAccountsPerUser: limit }).resolve()).maxAccountsPerUser).toBe(5)
    }
    expect((await settings({ maxAccountsPerUser: 20 }).resolve()).maxAccountsPerUser).toBe(20)
    expect((await settings({ maxAccountsPerUser: 1 }).resolve()).maxAccountsPerUser).toBe(1)
  })
})

describe('origin and mode validators', () => {
  it.each([
    'http://nextcloud',
    'https://cloud.home.lan',
    'https://cloud.home.lan:8443',
    'http://192.168.1.20',
    'http://192.168.1.20:8080',
    'http://[fd12:3456:789a::20]',
    'http://[fd12:3456:789a::20]:8080',
  ])('accepts the exact origin %s', (origin) => {
    expect(isExactHttpOrigin(origin)).toBe(true)
  })

  it.each([
    ['a trailing slash', 'http://nextcloud/'],
    ['a path', 'http://nextcloud/remote.php/dav'],
    ['a query', 'http://nextcloud?x=1'],
    ['credentials', 'http://admin:pw@nextcloud'],
    ['a default port spelled out', 'http://nextcloud:80'],
    ['a default https port spelled out', 'https://nextcloud:443'],
    ['upper-case letters', 'http://NextCloud'],
    ['a bare host', 'nextcloud'],
    ['a bare host and port', 'nextcloud:8080'],
    ['another scheme', 'ftp://nextcloud'],
    ['a wildcard', 'http://*.home.lan'],
    ['surrounding space', ' http://nextcloud'],
    ['an empty string', ''],
    ['a non-string', 8080],
  ])('refuses %s', (_label, value) => {
    expect(isExactHttpOrigin(value)).toBe(false)
  })

  it('accepts a list of distinct exact origins and nothing else', () => {
    expect(isDavBridgeOriginList([])).toBe(true)
    expect(isDavBridgeOriginList(['http://a', 'https://b:8443'])).toBe(true)
    expect(isDavBridgeOriginList(['http://a', 'http://a'])).toBe(false)
    expect(isDavBridgeOriginList(['http://a', 'http://b/'])).toBe(false)
    expect(isDavBridgeOriginList('http://a')).toBe(false)
    expect(isDavBridgeOriginList(Array.from({ length: 65 }, (_unused, index) => `http://host${index}`))).toBe(false)
    expect(isDavBridgeOriginList(Array.from({ length: 64 }, (_unused, index) => `http://host${index}`))).toBe(true)
  })

  it('accepts a mode name and refuses anything that is not one', () => {
    for (const name of ['relay', 'hub', 'relay-v2']) {
      expect(isDavBridgeModeName(name)).toBe(true)
    }
    for (const value of ['', 'Relay', 'relay mode', '2relay', 'a'.repeat(33), 7, null]) {
      expect(isDavBridgeModeName(value)).toBe(false)
    }
  })
})

describe('reading the environment', () => {
  const env =
    (values: Record<string, string>) =>
    (name: string): string | undefined =>
      values[name]

  it('reads nothing as nothing: every setting falls through to its default', () => {
    expect(readDavBridgeEnvironment(env({}), '/srv/gateway')).toEqual({
      baseline: {
        enabled: undefined,
        mode: undefined,
        allowAllUsers: undefined,
        allowedPrivateOrigins: undefined,
        maxAccountsPerUser: undefined,
        allowlistEnvOnly: false,
      },
      dataPath: path.resolve('/srv/gateway', 'data', 'dav-bridge'),
      rejectedOrigins: 0,
      modeIgnored: false,
    })
  })

  it('reads every variable', () => {
    const readout = readDavBridgeEnvironment(
      env({
        DAV_BRIDGE_ENABLED: 'true',
        DAV_BRIDGE_MODE: 'Relay',
        DAV_BRIDGE_ALLOW_ALL_USERS: 'yes',
        DAV_BRIDGE_ALLOWED_PRIVATE_ORIGINS: 'http://nextcloud, https://cloud.home.lan:8443',
        DAV_BRIDGE_ALLOWLIST_ENV_ONLY: '1',
        DAV_BRIDGE_MAX_ACCOUNTS_PER_USER: '12',
        DAV_BRIDGE_DATA_PATH: '/data/dav-bridge',
      }),
      '/srv/gateway',
    )

    expect(readout.baseline).toEqual({
      enabled: true,
      mode: 'relay',
      allowAllUsers: true,
      allowedPrivateOrigins: ['http://nextcloud', 'https://cloud.home.lan:8443'],
      maxAccountsPerUser: 12,
      allowlistEnvOnly: true,
    })
    expect(readout.dataPath).toBe('/data/dav-bridge')
  })

  it.each([
    ['true', true],
    ['TRUE', true],
    ['1', true],
    ['yes', true],
    ['on', true],
    [' true ', true],
    ['false', false],
    ['0', false],
    ['no', false],
    ['off', false],
    ['', undefined],
    ['maybe', undefined],
    ['enabled', undefined],
    ['2', undefined],
  ])('reads the boolean %p as %p', (raw, expected) => {
    expect(readDavBridgeBoolean(raw)).toBe(expected)
  })

  it('does not switch anything on for a value it cannot read', () => {
    const readout = readDavBridgeEnvironment(
      env({ DAV_BRIDGE_ENABLED: 'definitely', DAV_BRIDGE_ALLOW_ALL_USERS: 'sure', DAV_BRIDGE_ALLOWLIST_ENV_ONLY: 'x' }),
      '/srv',
    )

    expect(readout.baseline.enabled).toBeUndefined()
    expect(readout.baseline.allowAllUsers).toBeUndefined()
    expect(readout.baseline.allowlistEnvOnly).toBe(false)
  })

  it('drops origins that are not exact, counts them, and never repairs one into something the operator did not write', () => {
    const readout = readDavBridgeEnvironment(
      env({
        DAV_BRIDGE_ALLOWED_PRIVATE_ORIGINS:
          'http://nextcloud,http://nextcloud/remote.php/dav, ,http://NAS,nextcloud:8080,http://nextcloud,https://ok.lan',
      }),
      '/srv',
    )

    expect(readout.baseline.allowedPrivateOrigins).toEqual(['http://nextcloud', 'https://ok.lan'])
    expect(readout.rejectedOrigins).toBe(3)
  })

  it('treats a list in which every entry was dropped as an empty list, not as unset', () => {
    const readout = readDavBridgeEnvironment(env({ DAV_BRIDGE_ALLOWED_PRIVATE_ORIGINS: 'nextcloud' }), '/srv')

    expect(readout.baseline.allowedPrivateOrigins).toEqual([])
    expect(readout.rejectedOrigins).toBe(1)
  })

  it('caps the list at sixty-four origins', () => {
    const many = Array.from({ length: 80 }, (_unused, index) => `http://host${index}`).join(',')

    expect(parseDavBridgeOriginList(many).origins).toHaveLength(64)
  })

  it('passes an unimplemented mode through, and reports a value that is not a mode name at all', () => {
    expect(readDavBridgeEnvironment(env({ DAV_BRIDGE_MODE: 'hub' }), '/srv')).toMatchObject({
      baseline: { mode: 'hub' },
      modeIgnored: false,
    })
    expect(readDavBridgeEnvironment(env({ DAV_BRIDGE_MODE: 'relay; rm -rf' }), '/srv')).toMatchObject({
      baseline: { mode: undefined },
      modeIgnored: true,
    })
  })

  it.each(['0', '21', '100', '-3', '5.5', 'five', ''])('ignores the account limit %p', (raw) => {
    expect(
      readDavBridgeEnvironment(env({ DAV_BRIDGE_MAX_ACCOUNTS_PER_USER: raw }), '/srv').baseline.maxAccountsPerUser,
    ).toBeUndefined()
  })

  it.each([
    ['1', 1],
    ['5', 5],
    ['20', 20],
    [' 7 ', 7],
  ])('reads the account limit %p as %p', (raw, expected) => {
    expect(
      readDavBridgeEnvironment(env({ DAV_BRIDGE_MAX_ACCOUNTS_PER_USER: raw }), '/srv').baseline.maxAccountsPerUser,
    ).toBe(expected)
  })
})
