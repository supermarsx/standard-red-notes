// Canary listener for the DAV bridge test stack (docker-compose.dav-test.yml).
//
// It is NOT a CalDAV server. It records every request it receives so that a
// network-policy check can be judged by what actually arrived here: zero
// requests after an attack the relay must refuse, exactly one after the control
// it must allow. "The relay answered with an error" proves much less.
//
// Control endpoints (not counted, and only meant for the observer on the host):
//   GET  /__hits    -> { count, hits: [{ method, path, hasAuthorization, at }] }
//   POST /__reset   -> clears the record
//
// Everything else is a counted hit. A few paths answer with a redirect, so a
// test can check that the relay does not follow one off the account's origin:
//   /r/loopback   -> http://127.0.0.1:3000/healthcheck
//   /r/metadata   -> http://169.254.169.254/latest/meta-data/
//   /r/db         -> http://db:3306/
//   /r/server     -> http://server:3000/healthcheck
//   /r/https      -> https://canary:8080/dav/         (another scheme)
//   /r/elsewhere  -> http://radicale:5232/            (another host)
//   /r/same       -> /dav/landed/                     (same origin; followed)
//   /r/loop       -> /r/loop                          (never ends)
//   /unauthorized -> 401
//   /slow         -> never answers
//
// The Authorization header is never stored or echoed, only whether one came.
import http from 'node:http'

const hits = []
const REDIRECTS = {
  '/r/loopback': 'http://127.0.0.1:3000/healthcheck',
  '/r/metadata': 'http://169.254.169.254/latest/meta-data/',
  '/r/db': 'http://db:3306/',
  '/r/server': 'http://server:3000/healthcheck',
  '/r/https': 'https://canary:8080/dav/',
  '/r/elsewhere': 'http://radicale:5232/',
  '/r/same': '/dav/landed/',
  '/r/loop': '/r/loop',
}

const server = http.createServer((request, response) => {
  const path = (request.url ?? '').split('?')[0]

  if (path === '/__hits' && request.method === 'GET') {
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify({ count: hits.length, hits }))
    return
  }
  if (path === '/__reset' && request.method === 'POST') {
    hits.length = 0
    response.writeHead(204)
    response.end()
    return
  }

  request.resume()
  hits.push({
    method: request.method,
    path,
    hasAuthorization: typeof request.headers.authorization === 'string',
    at: new Date().toISOString(),
  })

  if (path in REDIRECTS) {
    response.writeHead(302, { location: REDIRECTS[path] })
    response.end()
    return
  }
  if (path === '/unauthorized') {
    response.writeHead(401, { 'www-authenticate': 'Basic realm="canary"' })
    response.end('unauthorized')
    return
  }
  if (path === '/slow') {
    return
  }
  response.writeHead(207, { 'content-type': 'application/xml; charset=utf-8', dav: '1, 3, calendar-access' })
  response.end('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"/>')
})

server.listen(8080, '0.0.0.0')
