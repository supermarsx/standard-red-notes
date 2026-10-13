/**
 * Standard Red Notes: reading a WebDAV `207 Multi-Status` body.
 *
 * The text comes from a server the person chose and nobody here controls, and
 * it is parsed in their browser. Two things follow. A document type declaration
 * is refused outright: a multistatus never needs one, and it is the only way an
 * XML document can define entities, which is how a small body expands into a
 * very large one. And nothing here trusts structure: every lookup is by
 * namespace and local name, and a body that is not a multistatus yields null.
 */

export const DAV_NS = 'DAV:'
export const CALDAV_NS = 'urn:ietf:params:xml:ns:caldav'
export const CALENDARSERVER_NS = 'http://calendarserver.org/ns/'
export const APPLE_ICAL_NS = 'http://apple.com/ns/ical/'
export const NEXTCLOUD_NS = 'http://nextcloud.com/ns'

/** `{namespace}localName`, the key a property is stored under. */
export const propertyKey = (namespace: string, localName: string): string => `{${namespace}}${localName}`

export type MultistatusResponse = {
  /** The href exactly as the server wrote it. */
  href: string
  /** A status given for the response as a whole, as multiget does for a missing resource. */
  status?: number
  /** Properties the server returned with a 2xx status, by {@link propertyKey}. */
  properties: Map<string, Element>
  /** Properties the server named but did not return (404 and the like), by {@link propertyKey}. */
  missing: Set<string>
}

export type Multistatus = {
  responses: MultistatusResponse[]
  /** The collection's new sync token, when the answer carries one. */
  syncToken?: string
}

const childElements = (parent: Element, namespace: string, localName: string): Element[] => {
  const found: Element[] = []
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 1) {
      const element = node as Element
      if (element.namespaceURI === namespace && element.localName === localName) {
        found.push(element)
      }
    }
  }
  return found
}

export const firstChild = (parent: Element, namespace: string, localName: string): Element | undefined =>
  childElements(parent, namespace, localName)[0]

export const allChildren = (parent: Element): Element[] => {
  const found: Element[] = []
  for (let node = parent.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 1) {
      found.push(node as Element)
    }
  }
  return found
}

export const textOf = (element: Element | undefined): string => (element?.textContent ?? '').trim()

/** The number in an HTTP status line such as `HTTP/1.1 404 Not Found`. */
const statusOf = (element: Element | undefined): number | undefined => {
  const match = /^HTTP\/\d(?:\.\d)?\s+(\d{3})\b/.exec(textOf(element))
  return match ? Number(match[1]) : undefined
}

/** Parse a multistatus body. Returns null for anything that is not one. */
export function parseMultistatus(xml: string): Multistatus | null {
  if (typeof xml !== 'string' || xml.length === 0 || /<!DOCTYPE|<!ENTITY/i.test(xml)) {
    return null
  }
  let root: Element | null
  try {
    const parsed = new DOMParser().parseFromString(xml, 'application/xml')
    root = parsed.documentElement
    if (parsed.getElementsByTagName('parsererror').length > 0) {
      return null
    }
  } catch {
    return null
  }
  if (!root || root.namespaceURI !== DAV_NS || root.localName !== 'multistatus') {
    return null
  }

  const responses: MultistatusResponse[] = []
  for (const response of childElements(root, DAV_NS, 'response')) {
    const href = textOf(firstChild(response, DAV_NS, 'href'))
    if (href.length === 0) {
      continue
    }
    const entry: MultistatusResponse = { href, properties: new Map(), missing: new Set() }
    const status = statusOf(firstChild(response, DAV_NS, 'status'))
    if (status !== undefined) {
      entry.status = status
    }
    for (const propstat of childElements(response, DAV_NS, 'propstat')) {
      const prop = firstChild(propstat, DAV_NS, 'prop')
      if (!prop) {
        continue
      }
      // A propstat with no status line is read as success, which is what it means in practice.
      const propStatus = statusOf(firstChild(propstat, DAV_NS, 'status')) ?? 200
      const found = propStatus >= 200 && propStatus < 300
      for (const property of allChildren(prop)) {
        const key = propertyKey(property.namespaceURI ?? '', property.localName)
        if (found) {
          entry.properties.set(key, property)
        } else {
          entry.missing.add(key)
        }
      }
    }
    responses.push(entry)
  }

  const multistatus: Multistatus = { responses }
  const syncToken = textOf(firstChild(root, DAV_NS, 'sync-token'))
  if (syncToken.length > 0) {
    multistatus.syncToken = syncToken
  }
  return multistatus
}

/**
 * The path an href names, in one spelling.
 *
 * Servers write hrefs as absolute paths, as full URLs, or relative to the
 * request, and do not always escape the same resource the same way twice. Each
 * segment is decoded and escaped again by one rule, so that the path an entry
 * was listed under and the path it was fetched under are the same string. An
 * href that leaves the origin, or that hides a slash or a dot segment inside an
 * escape, is refused (null): the relay would refuse it too, and a path that
 * cannot be trusted is not one to build a request from.
 */
export function pathOfHref(href: string, basePath: string, origin?: string): string | null {
  let url: URL
  try {
    // The host is a placeholder: only the path is used, and only when the href stayed on its origin.
    const base = new URL(basePath, origin ?? 'http://origin.invalid')
    url = new URL(href, base)
    if (url.origin !== base.origin) {
      return null
    }
  } catch {
    return null
  }
  const segments = url.pathname.split('/')
  const escaped: string[] = []
  for (const [index, segment] of segments.entries()) {
    if (segment === '') {
      // Only the leading and trailing empty segments of `/a/b/` are legitimate.
      if (index === 0 || index === segments.length - 1) {
        escaped.push('')
        continue
      }
      return null
    }
    let decoded: string
    try {
      decoded = decodeURIComponent(segment)
    } catch {
      return null
    }
    // eslint-disable-next-line no-control-regex
    if (decoded === '.' || decoded === '..' || /[/\\\u0000-\u001f\u007f]/.test(decoded)) {
      return null
    }
    escaped.push(encodeURIComponent(decoded))
  }
  const path = escaped.join('/')
  return path.startsWith('/') ? path : null
}

/** Escape text for an XML element body or attribute value. */
export const escapeXml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
