import {
  describeRequestingDevice,
  describeRequestingIpAddress,
  formatApprovalEntryLabel,
  isApprovalActionable,
  PendingMfaApproval,
} from './pendingMfaApproval'

describe('pendingMfaApproval helpers', () => {
  describe('describeRequestingDevice', () => {
    it('returns a fallback for an empty/whitespace user agent', () => {
      expect(describeRequestingDevice('')).toBe('Unknown device')
      expect(describeRequestingDevice('   ')).toBe('Unknown device')
    })

    it('detects Chrome on Windows', () => {
      const ua =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      expect(describeRequestingDevice(ua)).toBe('Chrome on Windows')
    })

    it('detects Firefox on Linux', () => {
      const ua = 'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0'
      expect(describeRequestingDevice(ua)).toBe('Firefox on Linux')
    })

    it('prefers Edge over the Chrome token it also carries', () => {
      const ua =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0'
      expect(describeRequestingDevice(ua)).toBe('Edge on Windows')
    })

    it('detects Safari on macOS without misfiring on the Chrome-only Safari token', () => {
      const ua =
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
      expect(describeRequestingDevice(ua)).toBe('Safari on macOS')
    })

    it('detects Safari on iOS', () => {
      const ua =
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      expect(describeRequestingDevice(ua)).toBe('Safari on iOS')
    })

    it('falls back to browser only when the OS is unknown', () => {
      expect(describeRequestingDevice('Firefox/121.0')).toBe('Firefox')
    })

    it('reports an unknown browser for an unrecognized UA', () => {
      expect(describeRequestingDevice('curl/8.0.1')).toBe('Unknown browser')
    })
  })

  describe('describeRequestingIpAddress', () => {
    it('returns the trimmed IP when present', () => {
      expect(describeRequestingIpAddress(' 203.0.113.7 ')).toBe('203.0.113.7')
    })

    it('returns a placeholder for null/empty', () => {
      expect(describeRequestingIpAddress(null)).toBe('unknown IP')
      expect(describeRequestingIpAddress('   ')).toBe('unknown IP')
    })
  })

  describe('formatApprovalEntryLabel', () => {
    it('joins device, ip and time', () => {
      const createdAt = new Date('2026-07-02T10:30:00Z').getTime()
      const approval: PendingMfaApproval = {
        uuid: 'a1',
        challengeId: 'c1',
        status: 'pending',
        requestingUserAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        requestingIpAddress: '203.0.113.7',
        createdAt,
        expiresAt: createdAt + 120000,
      }
      const label = formatApprovalEntryLabel(approval)
      expect(label.startsWith('Chrome on Windows · 203.0.113.7 · ')).toBe(true)
    })
  })

  describe('isApprovalActionable', () => {
    const base: PendingMfaApproval = {
      uuid: 'a1',
      challengeId: 'c1',
      status: 'pending',
      requestingUserAgent: '',
      requestingIpAddress: null,
      createdAt: 1000,
      expiresAt: 2000,
    }

    it('is actionable while pending and not expired', () => {
      expect(isApprovalActionable(base, 1500)).toBe(true)
    })

    it('is not actionable once the TTL has passed', () => {
      expect(isApprovalActionable(base, 2000)).toBe(false)
      expect(isApprovalActionable(base, 2500)).toBe(false)
    })

    it('is not actionable for a terminal status', () => {
      expect(isApprovalActionable({ ...base, status: 'approved' }, 1500)).toBe(false)
      expect(isApprovalActionable({ ...base, status: 'denied' }, 1500)).toBe(false)
      expect(isApprovalActionable({ ...base, status: 'expired' }, 1500)).toBe(false)
    })
  })
})
