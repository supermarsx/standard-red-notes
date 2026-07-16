import * as crypto from 'crypto'

import {
  countLeadingZeroBits,
  proofOfWorkSolutionMeetsDifficulty,
  PROOF_OF_WORK_ALGORITHM,
} from './ProofOfWorkDifficulty'

describe('ProofOfWorkDifficulty', () => {
  describe('countLeadingZeroBits', () => {
    it('counts full zero nibbles', () => {
      expect(countLeadingZeroBits('00ff')).toBe(8)
      expect(countLeadingZeroBits('000f')).toBe(12)
    })

    it('counts partial leading zeros within a nibble', () => {
      expect(countLeadingZeroBits('8000')).toBe(0)
      expect(countLeadingZeroBits('4000')).toBe(1)
      expect(countLeadingZeroBits('1000')).toBe(3)
      expect(countLeadingZeroBits('0800')).toBe(4)
      expect(countLeadingZeroBits('0100')).toBe(7)
    })

    it('returns 0 for a leading f', () => {
      expect(countLeadingZeroBits('ffffffff')).toBe(0)
    })

    it('stops safely at a malformed digest character', () => {
      expect(countLeadingZeroBits('not-a-hex-digest')).toBe(0)
      expect(countLeadingZeroBits('00x123')).toBe(8)
    })
  })

  describe('proofOfWorkSolutionMeetsDifficulty', () => {
    const solve = (seed: string, difficulty: number): string => {
      let nonce = 0

      while (true) {
        const digest = crypto.createHash('sha256').update(`${seed}:${nonce}`).digest('hex')
        if (countLeadingZeroBits(digest) >= difficulty) {
          return nonce.toString()
        }
        nonce++
      }
    }

    it('accepts a correctly-solved nonce at the issued difficulty', () => {
      const seed = 'seed-abc'
      const difficulty = 10
      const nonce = solve(seed, difficulty)

      expect(proofOfWorkSolutionMeetsDifficulty(seed, nonce, difficulty)).toBe(true)
    })

    it('rejects a nonce that does not meet the difficulty', () => {
      // A valid solution for difficulty 4 will almost never also satisfy 24.
      const seed = 'seed-xyz'
      const nonce = solve(seed, 4)

      expect(proofOfWorkSolutionMeetsDifficulty(seed, nonce, 24)).toBe(false)
    })

    it('is bound to the exact seed (a nonce for another seed does not transfer)', () => {
      const difficulty = 10
      const nonce = solve('seed-one', difficulty)

      expect(proofOfWorkSolutionMeetsDifficulty('seed-two', nonce, difficulty)).toBe(false)
    })

    it('treats difficulty <= 0 as no work required', () => {
      expect(proofOfWorkSolutionMeetsDifficulty('seed', 'anything', 0)).toBe(true)
    })

    it('rejects non-string inputs', () => {
      expect(proofOfWorkSolutionMeetsDifficulty(undefined as unknown as string, 'x', 4)).toBe(false)
      expect(proofOfWorkSolutionMeetsDifficulty('seed', undefined as unknown as string, 4)).toBe(false)
    })

    it('exposes a stable algorithm identifier', () => {
      expect(PROOF_OF_WORK_ALGORITHM).toBe('sha256-leading-zero-bits')
    })
  })
})
