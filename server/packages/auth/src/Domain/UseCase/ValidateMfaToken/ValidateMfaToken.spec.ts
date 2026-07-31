import 'reflect-metadata'

import { CryptoNode } from '@standardnotes/sncrypto-node'
import { Logger } from 'winston'

import { ValidateMfaToken } from './ValidateMfaToken'
import { ValidateMfaTokenDTO } from './ValidateMfaTokenDTO'
import { MfaSecretRepositoryInterface } from '../../Mfa/MfaSecretRepositoryInterface'
import {
  SECURITY_STEP_UP_UPDATE_REQUIRED_MESSAGE,
  SECURITY_STEP_UP_VALIDATION_FAILED_MESSAGE,
} from '../../Auth/SecurityStepUp'

describe('ValidateMfaToken', () => {
  let useCase: ValidateMfaToken
  let mockCryptoNode: jest.Mocked<CryptoNode>
  let mockMfaSecretRepository: jest.Mocked<MfaSecretRepositoryInterface>
  let logger: jest.Mocked<Pick<Logger, 'warn'>>

  beforeEach(() => {
    mockCryptoNode = {
      totpToken: jest.fn(),
    } as unknown as jest.Mocked<CryptoNode>

    mockMfaSecretRepository = {
      getMfaSecret: jest.fn(),
      setMfaSecret: jest.fn(),
      deleteMfaSecret: jest.fn(),
    }

    logger = {
      warn: jest.fn(),
    }

    useCase = new ValidateMfaToken(mockCryptoNode, mockMfaSecretRepository, logger as Logger)
  })

  describe('when authTokenVersion is less than 3', () => {
    it.each([1, 2])('should require a client update for token version %s', async (authTokenVersion) => {
      const dto: ValidateMfaTokenDTO = {
        userUuid: 'user-123',
        totpToken: '123456',
        authTokenVersion,
      }

      const result = await useCase.execute(dto)

      expect(result.isFailed()).toBe(true)
      expect(result.getError()).toBe(SECURITY_STEP_UP_UPDATE_REQUIRED_MESSAGE)
      expect(mockMfaSecretRepository.getMfaSecret).not.toHaveBeenCalled()
      expect(mockCryptoNode.totpToken).not.toHaveBeenCalled()
      expect(mockMfaSecretRepository.deleteMfaSecret).not.toHaveBeenCalled()
    })
  })

  describe('when authTokenVersion is 3 or higher', () => {
    it('should fail when no TOTP token is provided', async () => {
      const dto: ValidateMfaTokenDTO = {
        userUuid: 'user-123',
        totpToken: undefined,
        authTokenVersion: 3,
      }

      const result = await useCase.execute(dto)

      expect(result.isFailed()).toBe(true)
      expect(result.getError()).toBe('No TOTP token provided.')
      expect(mockMfaSecretRepository.getMfaSecret).not.toHaveBeenCalled()
      expect(mockCryptoNode.totpToken).not.toHaveBeenCalled()
      expect(mockMfaSecretRepository.deleteMfaSecret).not.toHaveBeenCalled()
    })

    it('should fail when TOTP token is empty string', async () => {
      const dto: ValidateMfaTokenDTO = {
        userUuid: 'user-123',
        totpToken: '',
        authTokenVersion: 3,
      }

      const result = await useCase.execute(dto)

      expect(result.isFailed()).toBe(true)
      expect(result.getError()).toBe('No TOTP token provided.')
      expect(mockMfaSecretRepository.getMfaSecret).not.toHaveBeenCalled()
      expect(mockCryptoNode.totpToken).not.toHaveBeenCalled()
      expect(mockMfaSecretRepository.deleteMfaSecret).not.toHaveBeenCalled()
    })

    it('should fail when no MFA secret is found', async () => {
      const dto: ValidateMfaTokenDTO = {
        userUuid: 'user-123',
        totpToken: '123456',
        authTokenVersion: 3,
      }

      mockMfaSecretRepository.getMfaSecret.mockResolvedValue(null)

      const result = await useCase.execute(dto)

      expect(result.isFailed()).toBe(true)
      expect(result.getError()).toBe('No MFA secret found. Please generate a new secret first.')
      expect(mockMfaSecretRepository.getMfaSecret).toHaveBeenCalledWith('user-123')
      expect(mockCryptoNode.totpToken).not.toHaveBeenCalled()
      expect(mockMfaSecretRepository.deleteMfaSecret).not.toHaveBeenCalled()
    })

    it('should fail when TOTP token is invalid', async () => {
      const dto: ValidateMfaTokenDTO = {
        userUuid: 'user-123',
        totpToken: '123456',
        authTokenVersion: 3,
      }

      const cachedSecret = 'JBSWY3DPEHPK3PXP'
      const expectedToken = '654321'

      mockMfaSecretRepository.getMfaSecret.mockResolvedValue(cachedSecret)
      mockCryptoNode.totpToken.mockResolvedValue(expectedToken)

      const result = await useCase.execute(dto)

      expect(result.isFailed()).toBe(true)
      expect(result.getError()).toBe('Invalid TOTP token.')
      expect(mockMfaSecretRepository.getMfaSecret).toHaveBeenCalledWith('user-123')
      expect(mockCryptoNode.totpToken).toHaveBeenCalledWith(cachedSecret, expect.any(Number), 6, 30)
      expect(mockMfaSecretRepository.deleteMfaSecret).not.toHaveBeenCalled()
    })

    it('should succeed when TOTP token is valid', async () => {
      const dto: ValidateMfaTokenDTO = {
        userUuid: 'user-123',
        totpToken: '123456',
        authTokenVersion: 3,
      }

      const cachedSecret = 'JBSWY3DPEHPK3PXP'
      const expectedToken = '123456'

      mockMfaSecretRepository.getMfaSecret.mockResolvedValue(cachedSecret)
      mockCryptoNode.totpToken.mockResolvedValue(expectedToken)
      mockMfaSecretRepository.deleteMfaSecret.mockResolvedValue()

      const result = await useCase.execute(dto)

      expect(result.isFailed()).toBe(false)
      expect(mockMfaSecretRepository.getMfaSecret).toHaveBeenCalledWith('user-123')
      expect(mockCryptoNode.totpToken).toHaveBeenCalledWith(cachedSecret, expect.any(Number), 6, 30)
      expect(mockMfaSecretRepository.deleteMfaSecret).toHaveBeenCalledWith('user-123')
    })
  })

  describe('when authTokenVersion is not provided', () => {
    it('should require a client update before validating any supplied proof', async () => {
      const dto: ValidateMfaTokenDTO = {
        userUuid: 'user-123',
        totpToken: '123456',
      }

      const result = await useCase.execute(dto)

      expect(result.isFailed()).toBe(true)
      expect(result.getError()).toBe(SECURITY_STEP_UP_UPDATE_REQUIRED_MESSAGE)
      expect(mockMfaSecretRepository.getMfaSecret).not.toHaveBeenCalled()
      expect(mockCryptoNode.totpToken).not.toHaveBeenCalled()
      expect(mockMfaSecretRepository.deleteMfaSecret).not.toHaveBeenCalled()
    })
  })

  describe('error handling', () => {
    it('should handle errors from getMfaSecret gracefully', async () => {
      const dto: ValidateMfaTokenDTO = {
        userUuid: 'user-123',
        totpToken: '123456',
        authTokenVersion: 3,
      }

      const error = new Error('Database connection failed')
      mockMfaSecretRepository.getMfaSecret.mockRejectedValue(error)

      const result = await useCase.execute(dto)

      expect(result.isFailed()).toBe(true)
      expect(result.getError()).toBe(SECURITY_STEP_UP_VALIDATION_FAILED_MESSAGE)
      expect(logger.warn).toHaveBeenCalledWith('Failed to validate MFA token.', {
        userId: 'user-123',
        errorType: 'Error',
        errorCode: undefined,
        status: undefined,
      })
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('Database connection failed')
      expect(mockMfaSecretRepository.getMfaSecret).toHaveBeenCalledWith('user-123')
      expect(mockCryptoNode.totpToken).not.toHaveBeenCalled()
      expect(mockMfaSecretRepository.deleteMfaSecret).not.toHaveBeenCalled()
    })

    it('should handle errors from totpToken gracefully', async () => {
      const dto: ValidateMfaTokenDTO = {
        userUuid: 'user-123',
        totpToken: '123456',
        authTokenVersion: 3,
      }

      const cachedSecret = 'JBSWY3DPEHPK3PXP'
      const error = new Error('Crypto operation failed')

      mockMfaSecretRepository.getMfaSecret.mockResolvedValue(cachedSecret)
      mockCryptoNode.totpToken.mockRejectedValue(error)

      const result = await useCase.execute(dto)

      expect(result.isFailed()).toBe(true)
      expect(result.getError()).toBe(SECURITY_STEP_UP_VALIDATION_FAILED_MESSAGE)
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('Crypto operation failed')
      expect(mockMfaSecretRepository.getMfaSecret).toHaveBeenCalledWith('user-123')
      expect(mockCryptoNode.totpToken).toHaveBeenCalledWith(cachedSecret, expect.any(Number), 6, 30)
      expect(mockMfaSecretRepository.deleteMfaSecret).not.toHaveBeenCalled()
    })

    it('should handle errors from deleteMfaSecret gracefully', async () => {
      const dto: ValidateMfaTokenDTO = {
        userUuid: 'user-123',
        totpToken: '123456',
        authTokenVersion: 3,
      }

      const cachedSecret = 'JBSWY3DPEHPK3PXP'
      const expectedToken = '123456'
      const error = new Error('Delete operation failed')

      mockMfaSecretRepository.getMfaSecret.mockResolvedValue(cachedSecret)
      mockCryptoNode.totpToken.mockResolvedValue(expectedToken)
      mockMfaSecretRepository.deleteMfaSecret.mockRejectedValue(error)

      const result = await useCase.execute(dto)

      expect(result.isFailed()).toBe(true)
      expect(result.getError()).toBe(SECURITY_STEP_UP_VALIDATION_FAILED_MESSAGE)
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('Delete operation failed')
      expect(mockMfaSecretRepository.getMfaSecret).toHaveBeenCalledWith('user-123')
      expect(mockCryptoNode.totpToken).toHaveBeenCalledWith(cachedSecret, expect.any(Number), 6, 30)
      expect(mockMfaSecretRepository.deleteMfaSecret).toHaveBeenCalledWith('user-123')
    })

    it('still returns the fixed failure when the logger transport throws', async () => {
      mockMfaSecretRepository.getMfaSecret.mockRejectedValue(new Error('repository detail'))
      logger.warn.mockImplementation(() => {
        throw new Error('logger unavailable')
      })

      const result = await useCase.execute({
        userUuid: 'user-123',
        totpToken: '123456',
        authTokenVersion: 3,
      })

      expect(result.isFailed()).toBe(true)
      expect(result.getError()).toBe(SECURITY_STEP_UP_VALIDATION_FAILED_MESSAGE)
    })
  })

  describe('edge cases', () => {
    it('should handle empty string as cached secret', async () => {
      const dto: ValidateMfaTokenDTO = {
        userUuid: 'user-123',
        totpToken: '123456',
        authTokenVersion: 3,
      }

      mockMfaSecretRepository.getMfaSecret.mockResolvedValue('')

      const result = await useCase.execute(dto)

      expect(result.isFailed()).toBe(true)
      expect(result.getError()).toBe('No MFA secret found. Please generate a new secret first.')
      expect(mockMfaSecretRepository.getMfaSecret).toHaveBeenCalledWith('user-123')
      expect(mockCryptoNode.totpToken).not.toHaveBeenCalled()
      expect(mockMfaSecretRepository.deleteMfaSecret).not.toHaveBeenCalled()
    })

    it('should handle authTokenVersion exactly equal to 3', async () => {
      const dto: ValidateMfaTokenDTO = {
        userUuid: 'user-123',
        totpToken: '123456',
        authTokenVersion: 3,
      }

      const cachedSecret = 'JBSWY3DPEHPK3PXP'
      const expectedToken = '123456'

      mockMfaSecretRepository.getMfaSecret.mockResolvedValue(cachedSecret)
      mockCryptoNode.totpToken.mockResolvedValue(expectedToken)
      mockMfaSecretRepository.deleteMfaSecret.mockResolvedValue()

      const result = await useCase.execute(dto)

      expect(result.isFailed()).toBe(false)
      expect(mockMfaSecretRepository.getMfaSecret).toHaveBeenCalledWith('user-123')
      expect(mockCryptoNode.totpToken).toHaveBeenCalledWith(cachedSecret, expect.any(Number), 6, 30)
      expect(mockMfaSecretRepository.deleteMfaSecret).toHaveBeenCalledWith('user-123')
    })

    it('should handle authTokenVersion greater than 3', async () => {
      const dto: ValidateMfaTokenDTO = {
        userUuid: 'user-123',
        totpToken: '123456',
        authTokenVersion: 5,
      }

      const cachedSecret = 'JBSWY3DPEHPK3PXP'
      const expectedToken = '123456'

      mockMfaSecretRepository.getMfaSecret.mockResolvedValue(cachedSecret)
      mockCryptoNode.totpToken.mockResolvedValue(expectedToken)
      mockMfaSecretRepository.deleteMfaSecret.mockResolvedValue()

      const result = await useCase.execute(dto)

      expect(result.isFailed()).toBe(false)
      expect(mockMfaSecretRepository.getMfaSecret).toHaveBeenCalledWith('user-123')
      expect(mockCryptoNode.totpToken).toHaveBeenCalledWith(cachedSecret, expect.any(Number), 6, 30)
      expect(mockMfaSecretRepository.deleteMfaSecret).toHaveBeenCalledWith('user-123')
    })
  })
})
