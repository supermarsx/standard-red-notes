import { MfaService } from './MfaService'

describe('MfaService magic-link settings', () => {
  const createService = (post: jest.Mock) =>
    new MfaService({} as never, {} as never, {} as never, {} as never, { post } as never, {} as never)

  it('surfaces the server error when email delivery prevents enabling magic-link sign-in', async () => {
    const post = jest.fn().mockResolvedValue({
      status: 400,
      data: {
        error: {
          message: 'Email delivery is not configured. Magic-link sign-in cannot be enabled.',
        },
      },
    })

    await expect(createService(post).setMagicLinkEnabled(true)).rejects.toThrow(
      'Email delivery is not configured. Magic-link sign-in cannot be enabled.',
    )
    expect(post).toHaveBeenCalledWith('/v1/mfa/magic-link/status', { enabled: true })
  })

  it('resolves only after the server confirms the setting update', async () => {
    const post = jest.fn().mockResolvedValue({
      status: 200,
      data: {
        enabled: true,
      },
    })

    await expect(createService(post).setMagicLinkEnabled(true)).resolves.toBeUndefined()
  })
})
