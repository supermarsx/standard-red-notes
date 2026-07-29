import { HttpStatusCode, User } from '@standardnotes/responses'
import { SettingsGateway } from './SettingsGateway'
import { SettingsList } from './SettingsList'
import { SettingsServerInterface } from './SettingsServerInterface'

const USER_UUID = '00000000-0000-0000-0000-000000000001'
const NEXTCLOUD_URL = 'NEXTCLOUD_BACKUP_URL'
const NEXTCLOUD_APP_PASSWORD = 'NEXTCLOUD_BACKUP_APP_PASSWORD'

describe('SettingsGateway raw setting names', () => {
  let settingsApi: jest.Mocked<SettingsServerInterface>
  let gateway: SettingsGateway

  beforeEach(() => {
    settingsApi = {
      getSetting: jest.fn(),
      updateSetting: jest.fn(),
    } as unknown as jest.Mocked<SettingsServerInterface>
    gateway = new SettingsGateway(settingsApi, {
      getUser: () => ({ uuid: USER_UUID }) as User,
    })
  })

  it('reads a listed setting by raw name', () => {
    const settings = new SettingsList([
      {
        name: NEXTCLOUD_URL,
        value: 'https://cloud.example.com',
      },
    ] as never)

    expect(settings.getRawSettingValue(NEXTCLOUD_URL, '')).toBe('https://cloud.example.com')
  })

  it('reads a setting without requiring it in the client SettingName enum', async () => {
    settingsApi.getSetting.mockResolvedValue({
      status: HttpStatusCode.Success,
      data: { setting: { value: 'https://cloud.example.com' } },
    } as never)

    await expect(gateway.getRawSetting(NEXTCLOUD_URL)).resolves.toBe('https://cloud.example.com')
    expect(settingsApi.getSetting).toHaveBeenCalledWith(USER_UUID, NEXTCLOUD_URL, undefined)
  })

  it('writes a setting without requiring it in the client SettingName enum', async () => {
    settingsApi.updateSetting.mockResolvedValue({
      status: HttpStatusCode.Success,
      data: {},
    } as never)

    await gateway.updateRawSetting(NEXTCLOUD_URL, 'https://cloud.example.com', false)

    expect(settingsApi.updateSetting).toHaveBeenCalledWith(
      USER_UUID,
      NEXTCLOUD_URL,
      'https://cloud.example.com',
      false,
      undefined,
    )
  })

  it('checks sensitive-setting existence without returning its value', async () => {
    settingsApi.getSetting.mockResolvedValue({
      status: HttpStatusCode.Success,
      data: { success: true },
    } as never)

    await expect(gateway.getDoesRawSensitiveSettingExist(NEXTCLOUD_APP_PASSWORD)).resolves.toBe(true)
    expect(settingsApi.getSetting).toHaveBeenCalledWith(USER_UUID, NEXTCLOUD_APP_PASSWORD)
  })

  it('reports a missing raw sensitive setting', async () => {
    settingsApi.getSetting.mockResolvedValue({
      status: HttpStatusCode.BadRequest,
    } as never)

    await expect(gateway.getDoesRawSensitiveSettingExist(NEXTCLOUD_APP_PASSWORD)).resolves.toBe(false)
  })
})
