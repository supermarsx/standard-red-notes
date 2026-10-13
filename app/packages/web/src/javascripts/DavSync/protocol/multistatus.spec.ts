import {
  CALDAV_NS,
  CALENDARSERVER_NS,
  DAV_NS,
  escapeXml,
  firstChild,
  parseMultistatus,
  pathOfHref,
  propertyKey,
  textOf,
} from './multistatus'

const wrap = (inner: string, attributes = ''): string =>
  `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:" xmlns:c="${CALDAV_NS}" xmlns:cs="${CALENDARSERVER_NS}"${attributes}>${inner}</d:multistatus>`

describe('parseMultistatus', () => {
  it('reads hrefs, found properties and missing properties apart', () => {
    const parsed = parseMultistatus(
      wrap(
        '<d:response><d:href>/alice/work/</d:href>' +
          '<d:propstat><d:prop><d:displayname>Work</d:displayname><cs:getctag>"abc"</cs:getctag></d:prop>' +
          '<d:status>HTTP/1.1 200 OK</d:status></d:propstat>' +
          '<d:propstat><d:prop><d:sync-token/><c:calendar-timezone/></d:prop>' +
          '<d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>',
      ),
    )
    expect(parsed?.responses).toHaveLength(1)
    const [response] = parsed?.responses ?? []
    expect(response.href).toBe('/alice/work/')
    expect(response.status).toBeUndefined()
    expect([...response.properties.keys()]).toEqual([
      propertyKey(DAV_NS, 'displayname'),
      propertyKey(CALENDARSERVER_NS, 'getctag'),
    ])
    expect(textOf(response.properties.get(propertyKey(DAV_NS, 'displayname')))).toBe('Work')
    expect([...response.missing]).toEqual([
      propertyKey(DAV_NS, 'sync-token'),
      propertyKey(CALDAV_NS, 'calendar-timezone'),
    ])
  })

  it('reads a status given for a whole response, as a multiget gives for a missing entry', () => {
    const parsed = parseMultistatus(
      wrap('<d:response><d:href>/alice/work/gone.ics</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>'),
    )
    expect(parsed?.responses[0]).toMatchObject({ href: '/alice/work/gone.ics', status: 404 })
    expect(parsed?.responses[0].properties.size).toBe(0)
  })

  it('reads the sync token of the answer itself, not one inside a response', () => {
    const parsed = parseMultistatus(
      wrap(
        '<d:response><d:href>/a/</d:href><d:propstat><d:prop><d:sync-token>inner</d:sync-token></d:prop>' +
          '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:sync-token>outer</d:sync-token>',
      ),
    )
    expect(parsed?.syncToken).toBe('outer')
  })

  it('reads elements by namespace, whatever prefix the server chose', () => {
    const parsed = parseMultistatus(
      '<multistatus xmlns="DAV:"><response><href>/a/</href><propstat><prop>' +
        `<C:calendar-home-set xmlns:C="${CALDAV_NS}"><href>/a/calendars/</href></C:calendar-home-set>` +
        '</prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>',
    )
    const home = parsed?.responses[0].properties.get(propertyKey(CALDAV_NS, 'calendar-home-set'))
    expect(home && textOf(firstChild(home, DAV_NS, 'href'))).toBe('/a/calendars/')
  })

  it('does not mistake an element of the same name in another namespace', () => {
    const parsed = parseMultistatus(
      wrap(
        '<d:response><d:href>/a/</d:href><d:propstat><d:prop><x:getctag xmlns:x="urn:other">nope</x:getctag></d:prop>' +
          '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>',
      ),
    )
    expect(parsed?.responses[0].properties.has(propertyKey(CALENDARSERVER_NS, 'getctag'))).toBe(false)
    expect(parsed?.responses[0].properties.has(propertyKey('urn:other', 'getctag'))).toBe(true)
  })

  it('treats a propstat with no status line as found, and skips a response with no href', () => {
    const parsed = parseMultistatus(
      wrap(
        '<d:response><d:propstat><d:prop><d:displayname>No href</d:displayname></d:prop></d:propstat></d:response>' +
          '<d:response><d:href> /b/ </d:href><d:propstat><d:prop><d:displayname>B</d:displayname></d:prop></d:propstat></d:response>',
      ),
    )
    expect(parsed?.responses.map((response) => response.href)).toEqual(['/b/'])
    expect(parsed?.responses[0].properties.size).toBe(1)
  })

  it.each([
    ['nothing', ''],
    ['text that is not XML', 'Not Found'],
    ['XML that does not close', '<d:multistatus xmlns:d="DAV:"><d:response>'],
    ['another document', '<html xmlns="http://www.w3.org/1999/xhtml"><body>Login</body></html>'],
    ['a multistatus in no namespace', '<multistatus><response><href>/a/</href></response></multistatus>'],
    ['an error element', '<d:error xmlns:d="DAV:"><d:valid-sync-token/></d:error>'],
  ])('answers null for %s', (_what, body) => {
    expect(parseMultistatus(body)).toBeNull()
  })

  it('refuses a document type declaration, the only way a body can define entities', () => {
    const bomb =
      '<?xml version="1.0"?><!DOCTYPE d [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;">]>' +
      '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/&b;/</d:href></d:response></d:multistatus>'
    expect(parseMultistatus(bomb)).toBeNull()
    expect(parseMultistatus(bomb.replace('<!DOCTYPE', '<!doctype'))).toBeNull()
    // The same body without the declaration is an ordinary multistatus.
    expect(parseMultistatus(wrap('<d:response><d:href>/a/</d:href></d:response>'))?.responses).toHaveLength(1)
  })
})

describe('pathOfHref', () => {
  it.each([
    ['an absolute path', '/alice/work/one.ics', '/alice/work/one.ics'],
    ['a collection', '/alice/work/', '/alice/work/'],
    ['a full URL on the same origin', 'https://cloud.example.org/alice/work/one.ics', '/alice/work/one.ics'],
    ['a path relative to the request', 'one.ics', '/alice/work/one.ics'],
    ['a parent reference, resolved the way a browser would', '../tasks/', '/alice/tasks/'],
    ['a query and a fragment, dropped', '/alice/work/one.ics?x=1#frag', '/alice/work/one.ics'],
  ])('reads %s', (_what, href, path) => {
    expect(pathOfHref(href, '/alice/work/', 'https://cloud.example.org')).toBe(path)
  })

  it.each([
    ['an at sign', '/calendars/alice@example.org/work/', '/calendars/alice%40example.org/work/'],
    [
      'an at sign that is already escaped',
      '/calendars/alice%40example.org/work/',
      '/calendars/alice%40example.org/work/',
    ],
    ['a space', '/alice/my calendar/', '/alice/my%20calendar/'],
    ['a space that is already escaped', '/alice/my%20calendar/', '/alice/my%20calendar/'],
    ['an escape in lower case', '/alice/caf%c3%a9/', '/alice/caf%C3%A9/'],
    ['a letter that needs escaping', '/alice/café/', '/alice/caf%C3%A9/'],
    ['a plus, which is not a space in a path', '/alice/a+b.ics', '/alice/a%2Bb.ics'],
    ['a needless escape', '/alice/%61bc.ics', '/alice/abc.ics'],
    ['punctuation that needs no escape', "/alice/it's-(1)_2.~!*.ics", "/alice/it's-(1)_2.~!*.ics"],
  ])('spells %s one way', (_what, href, path) => {
    expect(pathOfHref(href, '/', 'https://cloud.example.org')).toBe(path)
  })

  it('gives one path for the two spellings a server may use for the same entry', () => {
    const listed = pathOfHref('/alice/work/Team%20meeting%20%40%20HQ.ics', '/alice/work/')
    const fetched = pathOfHref('/alice/work/Team meeting @ HQ.ics', '/alice/work/')
    expect(listed).toBe('/alice/work/Team%20meeting%20%40%20HQ.ics')
    expect(fetched).toBe(listed)
  })

  it.each([
    ['another host', 'https://evil.example.net/alice/work/one.ics'],
    ['another port', 'https://cloud.example.org:8443/alice/work/one.ics'],
    ['another scheme', 'http://cloud.example.org/alice/work/one.ics'],
    ['a host given without a scheme', '//evil.example.net/alice/'],
    ['a slash hidden in an escape', '/alice/work%2Fother/one.ics'],
    ['a backslash hidden in an escape', '/alice/work%5Cother/one.ics'],
    ['a control character hidden in an escape', '/alice/work%0d%0aone.ics'],
    ['an empty segment', '/alice//one.ics'],
    ['an escape that is not one', '/alice/100%/one.ics'],
    ['bytes that are not text', '/alice/%ff%fe/one.ics'],
  ])('refuses %s', (_what, href) => {
    expect(pathOfHref(href, '/alice/work/', 'https://cloud.example.org')).toBeNull()
  })

  it('cannot be walked out of the origin with dot segments, escaped or not', () => {
    // Resolved the way the server itself will resolve them, so that the path sent is the path meant.
    expect(pathOfHref('/alice/../../etc/passwd', '/alice/')).toBe('/etc/passwd')
    expect(pathOfHref('/alice/%2e%2e/bob/', '/alice/')).toBe('/bob/')
    expect(pathOfHref('/alice/./work/', '/alice/')).toBe('/alice/work/')
  })
})

describe('escapeXml', () => {
  it('escapes the four characters that could end the text it is put in', () => {
    expect(escapeXml(`a&b<c>d"e'f`)).toBe(`a&amp;b&lt;c&gt;d&quot;e'f`)
    expect(escapeXml('&amp;')).toBe('&amp;amp;')
  })
})
