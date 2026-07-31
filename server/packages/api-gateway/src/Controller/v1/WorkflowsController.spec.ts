import 'reflect-metadata'

import { Request, Response } from 'express'
import { SettingName } from '@standardnotes/domain-core'

import { WorkflowsController } from './WorkflowsController'
import { WorkflowsService } from '../../Service/Workflows/WorkflowsService'

describe('WorkflowsController', () => {
  let jsonMock: jest.Mock
  let setHeaderMock: jest.Mock

  const entitled = { [SettingName.NAMES.WorkflowsEnabled]: 'true' }

  const request = (host = 'attacker-controlled.invalid'): Request =>
    ({
      protocol: 'http',
      get: jest.fn((name: string) => (name.toLowerCase() === 'host' ? host : undefined)),
    }) as unknown as Request

  const responseWith = (settings?: Record<string, unknown>): Response => {
    jsonMock = jest.fn()
    setHeaderMock = jest.fn()
    return {
      locals: { user: { uuid: '1-2-3' }, settings },
      json: jsonMock,
      setHeader: setHeaderMock,
    } as unknown as Response
  }

  const makeController = (
    enabled: boolean,
    publicUrl: string | null,
    applicationPublicUrl: string | null = 'https://notes.example.com',
  ) => new WorkflowsController(new WorkflowsService({ enabled, publicUrl, applicationPublicUrl }))

  it('returns a separately authenticated external URL only when both gates are enabled', async () => {
    await makeController(true, 'https://n8n.example.com').status(request(), responseWith(entitled))

    expect(jsonMock).toHaveBeenCalledWith({
      enabled: true,
      available: true,
      publicUrl: 'https://n8n.example.com/',
      configurationError: false,
      authentication: 'n8n',
    })
    expect(setHeaderMock).toHaveBeenCalledWith('Cache-Control', 'private, no-store')
    expect(setHeaderMock).toHaveBeenCalledWith('Referrer-Policy', 'no-referrer')
  })

  it('withholds the URL when the operator switch is off', async () => {
    await makeController(false, 'https://n8n.example.com').status(request(), responseWith(entitled))

    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, available: false, publicUrl: null, configurationError: false }),
    )
  })

  it('fails closed when the per-user flag is absent or false', async () => {
    const controller = makeController(true, 'https://n8n.example.com')

    await controller.status(request(), responseWith(undefined))
    expect(jsonMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false, available: false, publicUrl: null }),
    )

    await controller.status(request(), responseWith({ [SettingName.NAMES.WorkflowsEnabled]: 'false' }))
    expect(jsonMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false, available: false, publicUrl: null }),
    )
  })

  it('reports operator misconfiguration without reflecting the unsafe URL', async () => {
    await makeController(true, 'http://n8n:5678').status(request(), responseWith(entitled))

    expect(jsonMock).toHaveBeenCalledWith({
      enabled: true,
      available: false,
      publicUrl: null,
      configurationError: true,
      authentication: 'n8n',
    })
  })

  it('rejects the configured Standard Red Notes hostname', async () => {
    await makeController(true, 'https://notes.example.com/n8n').status(request(), responseWith(entitled))

    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, available: false, publicUrl: null, configurationError: true }),
    )
  })

  it('rejects the SRN hostname even when n8n uses a different port', async () => {
    await makeController(true, 'https://notes.example.com:8443').status(request(), responseWith(entitled))

    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, available: false, publicUrl: null, configurationError: true }),
    )
  })

  it('uses configured PUBLIC_URL rather than a hostile request Host header', async () => {
    await makeController(true, 'https://n8n.example.net').status(request('n8n.example.net'), responseWith(entitled))

    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, available: true, publicUrl: 'https://n8n.example.net/' }),
    )
  })

  it('fails closed when configured PUBLIC_URL is missing or unsafe', async () => {
    await makeController(true, 'https://n8n.example.net', null).status(request(), responseWith(entitled))
    expect(jsonMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: true, available: false, publicUrl: null, configurationError: true }),
    )

    await makeController(true, 'https://n8n.example.net', 'http://notes.example.com').status(
      request(),
      responseWith(entitled),
    )
    expect(jsonMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: true, available: false, publicUrl: null, configurationError: true }),
    )
  })

  it('allows explicit loopback HTTP only for loopback development', async () => {
    await makeController(true, 'http://127.0.0.1:5678').status(request(), responseWith(entitled))

    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, available: true, publicUrl: 'http://127.0.0.1:5678/' }),
    )
  })
})
