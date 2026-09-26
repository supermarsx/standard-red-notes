import { readFileSync } from 'fs'
import { join } from 'path'
import { isValidTweetUrl, parseTweetUrl, sanitizeTweetUrl } from './sanitizeTweetUrl'

describe('sanitizeTweetUrl', () => {
  it('normalizes a status permalink to a canonical https twitter.com URL', () => {
    expect(sanitizeTweetUrl('https://x.com/jack/status/20?s=21&utm_source=x')).toBe(
      'https://twitter.com/jack/status/20',
    )
    expect(sanitizeTweetUrl('https://twitter.com/jack/statuses/20/')).toBe('https://twitter.com/jack/status/20')
  })

  it('rejects anything that is not a twitter/x status permalink', () => {
    for (const rejected of [
      '',
      'jack/status/20',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'https://twitter.com.attacker.example/jack/status/20',
      'https://x.com/jack',
      'https://example.com/jack/status/20',
    ]) {
      expect(sanitizeTweetUrl(rejected)).toBe('')
      expect(isValidTweetUrl(rejected)).toBe(false)
    }
  })
})

describe('parseTweetUrl', () => {
  it('splits a valid permalink into the handle and status id', () => {
    expect(parseTweetUrl('https://x.com/jack/status/20?s=21')).toEqual({
      handle: 'jack',
      statusId: '20',
      url: 'https://twitter.com/jack/status/20',
    })
  })

  it('returns null for every URL sanitizeTweetUrl would reject', () => {
    // The block renders a reference from this, so it must never describe a URL it
    // would not have been allowed to link to.
    for (const rejected of ['', 'https://x.com/jack', 'javascript:alert(1)', 'https://evil.example/a/status/1']) {
      expect(parseTweetUrl(rejected)).toBeNull()
    }
  })
})

describe('the Tweet block contacts nobody', () => {
  // The block used to append platform.twitter.com/widgets.js to the TOP document.
  // That was refused by the app's own CSP (script-src 'self' …) so it never worked,
  // and permitting the host would have let X's script run beside decrypted note
  // content. It is now rendered from the URL in the note. If a third-party script
  // load ever returns, opening a note starts telling X that it was read — so guard
  // the source itself rather than the behaviour, which no unit test would notice.
  const source = readFileSync(join(__dirname, 'TweetEmbedNode.tsx'), 'utf8')

  it('loads no third-party script and creates no script element', () => {
    expect(source).not.toMatch(/createElement\(\s*['"`]script['"`]\s*\)/)
    // A QUOTED url, i.e. one the code could actually fetch. The comment in that
    // file names the host deliberately, to explain why it is no longer loaded;
    // asserting on the bare host would forbid documenting the history.
    expect(source).not.toMatch(/['"`]https:\/\/platform\.twitter\.com/)
    expect(source).not.toMatch(/window\.twttr/)
  })

  it('still offers a way out to the original post', () => {
    expect(source).toContain('Open on X')
    expect(source).toContain('rel="noopener noreferrer"')
  })
})
