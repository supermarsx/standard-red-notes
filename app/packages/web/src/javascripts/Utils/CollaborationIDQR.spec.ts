/**
 * @jest-environment jsdom
 */

import { collaborationIDFromQRPayload, isValidCollaborationID, parseCollaborationIDSafely } from './CollaborationIDQR'

const Uuid = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const PublicKey = 'pubkey123'
const SigningPublicKey = 'signkey456'

const buildCollaborationID = (
  version = '1',
  userUuid = Uuid,
  publicKey = PublicKey,
  signingPublicKey = SigningPublicKey,
) => btoa(`${version}:${userUuid}:${publicKey}:${signingPublicKey}`)

describe('CollaborationIDQR', () => {
  describe('parseCollaborationIDSafely', () => {
    it('should parse a valid collaboration ID', () => {
      const result = parseCollaborationIDSafely(buildCollaborationID())
      expect(result).toEqual({
        version: '1',
        userUuid: Uuid,
        publicKey: PublicKey,
        signingPublicKey: SigningPublicKey,
      })
    })

    it('should tolerate surrounding whitespace', () => {
      const result = parseCollaborationIDSafely(`  ${buildCollaborationID()}\n`)
      expect(result).not.toBeUndefined()
    })

    it('should reject empty and whitespace-only strings', () => {
      expect(parseCollaborationIDSafely('')).toBeUndefined()
      expect(parseCollaborationIDSafely('   ')).toBeUndefined()
    })

    it('should reject non-base64 payloads', () => {
      expect(parseCollaborationIDSafely('not base64 at all!!!')).toBeUndefined()
      expect(parseCollaborationIDSafely('https://example.com/some-url')).toBeUndefined()
    })

    it('should reject base64 payloads that are not collaboration IDs', () => {
      expect(parseCollaborationIDSafely(btoa('hello world'))).toBeUndefined()
      expect(parseCollaborationIDSafely(btoa('a:b'))).toBeUndefined()
      expect(parseCollaborationIDSafely(btoa('a:b:c:d:e'))).toBeUndefined()
    })

    it('should reject unsupported versions', () => {
      expect(parseCollaborationIDSafely(buildCollaborationID('2'))).toBeUndefined()
      expect(parseCollaborationIDSafely(buildCollaborationID(''))).toBeUndefined()
    })

    it('should reject malformed user uuids', () => {
      expect(parseCollaborationIDSafely(buildCollaborationID('1', 'not-a-uuid'))).toBeUndefined()
      expect(parseCollaborationIDSafely(buildCollaborationID('1', ''))).toBeUndefined()
    })

    it('should reject empty keys', () => {
      expect(parseCollaborationIDSafely(buildCollaborationID('1', Uuid, ''))).toBeUndefined()
      expect(parseCollaborationIDSafely(buildCollaborationID('1', Uuid, PublicKey, ''))).toBeUndefined()
    })
  })

  describe('isValidCollaborationID', () => {
    it('should return true for a valid collaboration ID', () => {
      expect(isValidCollaborationID(buildCollaborationID())).toBe(true)
    })

    it('should return false for garbage', () => {
      expect(isValidCollaborationID('garbage')).toBe(false)
    })
  })

  describe('collaborationIDFromQRPayload', () => {
    it('should return the trimmed collaboration ID for valid payloads', () => {
      const id = buildCollaborationID()
      expect(collaborationIDFromQRPayload(` ${id} `)).toBe(id)
    })

    it('should return undefined for invalid payloads', () => {
      expect(collaborationIDFromQRPayload('WIFI:S:MyNetwork;T:WPA;P:pass;;')).toBeUndefined()
    })
  })
})
