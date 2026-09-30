import { type BrowserContext, type Page, type Response, expect } from '@playwright/test'

/**
 * Proves, at runtime, that a browser run really obtained a COOKIE-BASED session.
 *
 * WHY THIS EXISTS. Every session-shaped defect this repo has shipped was invisible
 * because the suite that should have caught it ran in the one configuration where
 * the defect cannot occur. `forceLegacySessions` is bound to `E2E_TESTING === 'true'`
 * (auth `Bootstrap/Container.ts`), and `shouldOperateOnCookieBasedSessions` refuses
 * the cookie branch whenever that flag is set (auth `Domain/Session/SessionService.ts`).
 * So a green run under `E2E_TESTING` says nothing at all about cookie sessions, and a
 * check that cannot demonstrate which kind of session it got is worthless here.
 *
 * Production is the opposite configuration. Shipped containers default the flag false
 * (`server/docker/single/entrypoint.sh` pins it false; no compose file sets it), and
 * the web client's api version is `20240226` (`app/packages/api/.../ApiVersion.ts`),
 * which is exactly the version `shouldOperateOnCookieBasedSessions` accepts. So every
 * real web sign-in is cookie-based, and this helper asserts the run matched it.
 *
 * WHICH CHECKS ACTUALLY SEPARATE THE TWO MODES — measured against a live stack in both,
 * not reasoned from the source, because two of the obvious candidates do NOT separate
 * them. At api `20240226` the legacy configuration still returns a full `session` object
 * AND still sets both `HttpOnly` cookies: `Register` picks the session-object response
 * from the api version, and `BaseAuthController` sets the cookies unconditionally on
 * that branch. Asserting either one would have looked like a cookie-session check and
 * passed happily under `E2E_TESTING`. Exactly two things discriminate:
 *
 *   1. `session.access_token` is `2:<privateIdentifier>` — EXACTLY two colon-separated
 *      parts with a leading `2`. `SessionService.createTokens` mints
 *      `${COOKIE_SESSION_TOKEN_VERSION}:${privateIdentifier}` for a cookie session and
 *      `${SESSION_TOKEN_VERSION}:${uuid}:${accessToken}` (three parts, leading `1`) for a
 *      legacy one. Live: `2:9d4a…` without the flag, `1:<uuid>:<token>` with it.
 *   2. The bearer ALONE is refused. A cookie session has exactly one authentication
 *      route — `GetSessionFromToken`'s version-2 branch reads `access_token_<uuid>` from
 *      the cookies, and its version-1 branch separately refuses any COOKIE_BASED
 *      session. Live: a cookie session answers 401 to a bearer-only request, a legacy
 *      session 200. This is the shipped defect itself: every socket lane presented a
 *      bearer with no cookie, and every one was refused, deterministically, while the
 *      whole suite stayed green.
 *
 * The remaining checks below are not discriminators and are not pretended to be. They
 * pin the rest of the cookie contract: the `HttpOnly` `access_token_*` cookie exists
 * (`CookieFactory`), the browser accepted it into its jar — that jar is what the socket
 * ticket capture reads — and JavaScript cannot see it. The body-shape guard only catches
 * a pre-20240226 client, which the web client never is. Through the front door the
 * api-gateway wraps the body as `{ meta, data: { session, … } }`, so the reader accepts
 * either envelope.
 *
 * VERIFIED to fail under `E2E_TESTING=true`: the prefix check reports `got "1:"` and the
 * spec goes red. This helper cannot read green in the legacy configuration, which is
 * what makes it evidence rather than decoration.
 */

/**
 * The two legs that mint a session, each as the set of gateway pathnames that serve it.
 *
 * Sign-in is a SET because the client picks the route: the web client's snjs signs in
 * over PKCE at `Paths.v2.signIn` = `/v2/login` (`ActionsControllerV2`), while `/v1/login`
 * (`ActionsController`) is the plain route older clients use. Matching only one of them
 * would leave this helper silently observing nothing, which reads as "no session was
 * minted" — a confusing failure for a run that actually signed in fine.
 */
const SESSION_MINTING_ROUTES = {
  register: ['/v1/users'],
  signIn: ['/v2/login', '/v1/login'],
} as const

export type SessionRoute = keyof typeof SESSION_MINTING_ROUTES

const ACCESS_TOKEN_COOKIE_PREFIX = 'access_token_'
const COOKIE_SESSION_TOKEN_VERSION = '2'

/** A cheap authenticated GET, used only to prove the bearer alone is refused. */
const BEARER_PROBE_PATH = '/v1/sessions'

/** One observed session-minting response, reduced to what decides the session type. */
export type SessionMintObservation = {
  /** Which leg this was: account creation, or a sign-in. */
  route: SessionRoute
  /** The concrete pathname that served it. */
  path: string
  status: number
  /** `session.access_token`, when the body carried a session object at all. */
  accessToken: string | null
  /** True when the body carried the legacy bare `token` instead of a `session` object. */
  legacyTokenBody: boolean
  /** Top-level keys of the payload, so a shape change says so instead of reading as a null token. */
  payloadKeys: string[]
  /** Every `Set-Cookie` name this response sent, in order. */
  setCookieNames: string[]
  /** True when an `access_token_*` cookie was set AND marked `HttpOnly`. */
  httpOnlyAccessTokenCookie: boolean
}

/**
 * A live recorder of session-minting responses on one page.
 *
 * Attach it BEFORE the navigation that registers or signs in — a listener added
 * afterwards sees nothing and would leave the assertions below with no evidence,
 * which they report as a failure rather than a pass.
 */
export type SessionMintRecorder = {
  /** Every session-minting response seen so far, oldest first. */
  observations(): SessionMintObservation[]
  /** Wait for the body reads of every response seen so far to finish. */
  settle(): Promise<void>
  /** Stop listening. Safe to call more than once. */
  dispose(): void
}

function decodeBody(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function observedRoute(url: string): { route: SessionRoute; path: string } | null {
  let pathname: string
  try {
    pathname = new URL(url).pathname
  } catch {
    return null
  }

  for (const route of Object.keys(SESSION_MINTING_ROUTES) as SessionRoute[]) {
    if ((SESSION_MINTING_ROUTES[route] as readonly string[]).includes(pathname)) {
      return { route, path: pathname }
    }
  }

  return null
}

/**
 * Reduce one response to a `SessionMintObservation`, or `null` if it is not a
 * session-minting response. Exported so the shape can be exercised without a browser.
 */
export async function observeSessionMint(response: Response): Promise<SessionMintObservation | null> {
  const matched = observedRoute(response.url())
  if (matched === null || response.request().method() !== 'POST') {
    return null
  }

  let body: Record<string, unknown> | null = null
  try {
    body = decodeBody(await response.text())
  } catch {
    // A body that cannot be read at all still tells us the route was hit; the
    // assertions below will fail on the missing access token, which is correct.
    body = null
  }

  // The api-gateway wraps every service response as `{ meta, data: { … } }`, so the
  // session lives one level down through the front door and at the top level when a
  // caller talks to auth directly. Accept both rather than pinning the envelope.
  const payload = body && typeof body.data === 'object' && body.data !== null ? (body.data as Record<string, unknown>) : body

  const session =
    payload && typeof payload.session === 'object' && payload.session !== null
      ? (payload.session as Record<string, unknown>)
      : null
  const accessToken = session && typeof session.access_token === 'string' ? session.access_token : null

  // `headersArray` keeps repeated `Set-Cookie` headers separate; `headers()` joins
  // them, which would make "how many cookies" unanswerable.
  const setCookies = (await response.headersArray())
    .filter((header) => header.name.toLowerCase() === 'set-cookie')
    .map((header) => header.value)

  const setCookieNames = setCookies.map((value) => value.split('=')[0].trim())
  const httpOnlyAccessTokenCookie = setCookies.some(
    (value) =>
      value.split('=')[0].trim().startsWith(ACCESS_TOKEN_COOKIE_PREFIX) &&
      value
        .split(';')
        .slice(1)
        .some((attribute) => attribute.trim().toLowerCase() === 'httponly'),
  )

  return {
    route: matched.route,
    path: matched.path,
    status: response.status(),
    accessToken,
    legacyTokenBody: session === null && payload !== null && typeof payload.token === 'string',
    payloadKeys: payload === null ? [] : Object.keys(payload),
    setCookieNames,
    httpOnlyAccessTokenCookie,
  }
}

/** Start recording session-minting responses on `page`. Attach before navigating. */
export function recordSessionMints(page: Page): SessionMintRecorder {
  const observations: SessionMintObservation[] = []
  const pending: Promise<void>[] = []

  const listener = (response: Response): void => {
    pending.push(
      observeSessionMint(response)
        .then((observation) => {
          if (observation !== null) {
            observations.push(observation)
          }
        })
        .catch(() => {
          // Swallowed on purpose: a response whose body vanished must not reject an
          // unawaited promise and tear down the run. It simply leaves no evidence,
          // and `expectCookieBasedSession` fails on the absence.
        }),
    )
  }

  page.on('response', listener)

  return {
    observations: () => [...observations],
    settle: async () => {
      // Re-read the queue after awaiting: a body read that finishes late can push
      // another entry while we are waiting on the earlier ones.
      let drained = 0
      while (drained < pending.length) {
        const batch = pending.slice(drained)
        drained = pending.length
        await Promise.allSettled(batch)
      }
    },
    dispose: () => page.off('response', listener),
  }
}

/**
 * Assert that the run obtained a genuine cookie-based session on `path`.
 *
 * `label` names the leg (which context, which sign-in) so a failure says which one.
 */
export async function expectCookieBasedSession(options: {
  recorder: SessionMintRecorder
  context: BrowserContext
  page: Page
  route: SessionRoute
  /** Names the leg, so a failure says which one. */
  label: string
  /** The app origin, used for the bearer-alone refusal probe below. */
  baseURL: string | undefined
}): Promise<SessionMintObservation> {
  const { recorder, context, page, route, label, baseURL } = options

  // The recorder buffers body reads; let the last of them finish before concluding
  // that a response never arrived.
  await recorder.settle()

  const matching = recorder
    .observations()
    .filter((observation) => observation.route === route && observation.status < 400)
  expect(
    matching.length,
    `${label}: no successful ${route} response on any of ${JSON.stringify(SESSION_MINTING_ROUTES[route])}; ` +
      `saw ${JSON.stringify(recorder.observations())}`,
  ).toBeGreaterThan(0)

  const observation = matching[matching.length - 1]

  // Pre-20240226 clients get `{ token }` and no session object at all. The web client
  // never does, so this is a shape guard rather than the legacy-session discriminator —
  // see the note above about which of these checks actually separates the two modes.
  expect(
    observation.legacyTokenBody,
    `${label}: POST ${observation.path} answered the pre-20240226 bare-token body instead of a ` +
      'session object. That is not the api version the web client uses.',
  ).toBe(false)

  expect(
    observation.accessToken,
    `${label}: POST ${observation.path} returned no session.access_token; payload keys were ${JSON.stringify(observation.payloadKeys)}`,
  ).not.toBeNull()

  // DISCRIMINATOR 1, measured against a live stack in both modes. Under
  // forceLegacySessions the SAME route at the SAME api version answers
  // `1:<uuid>:<token>`; a cookie session answers `2:<privateIdentifier>`.
  const accessToken = observation.accessToken as string
  const parts = accessToken.split(':')
  expect(
    parts[0],
    `${label}: session.access_token must carry the cookie-session version prefix ` +
      `"${COOKIE_SESSION_TOKEN_VERSION}:"; got "${parts[0]}:". A "1:" prefix means the server is ` +
      'running with E2E_TESTING=true (forceLegacySessions) — the one configuration in which a ' +
      'cookie-session defect cannot occur, so this run would prove nothing about cookie sessions.',
  ).toBe(COOKIE_SESSION_TOKEN_VERSION)
  expect(
    parts.length,
    `${label}: a cookie-session access token is "2:<privateIdentifier>" — exactly two parts. ` +
      `A three-part token is the LEGACY "1:<uuid>:<token>" shape.`,
  ).toBe(2)

  expect(
    observation.httpOnlyAccessTokenCookie,
    `${label}: POST ${observation.path} set no HttpOnly ${ACCESS_TOKEN_COOKIE_PREFIX}* cookie; ` +
      `Set-Cookie names were ${JSON.stringify(observation.setCookieNames)}. That cookie is the ` +
      'only credential auth will accept for a cookie session.',
  ).toBe(true)

  // The jar, not just the header: the browser must have ACCEPTED the cookie, because
  // that is what every later authenticated request — and the socket ticket capture —
  // actually sends.
  const jarNames = (await context.cookies()).map((cookie) => cookie.name)
  expect(
    jarNames.filter((name) => name.startsWith(ACCESS_TOKEN_COOKIE_PREFIX)).length,
    `${label}: the browser context holds no ${ACCESS_TOKEN_COOKIE_PREFIX}* cookie; jar was ${JSON.stringify(jarNames)}`,
  ).toBeGreaterThan(0)

  // …and JavaScript must not be able to read it. HttpOnly is what keeps the access
  // token out of the page, so a readable one is not the credential production issues.
  const documentCookie = await page.evaluate(() => document.cookie)
  expect(
    documentCookie.includes(ACCESS_TOKEN_COOKIE_PREFIX),
    `${label}: document.cookie exposed an ${ACCESS_TOKEN_COOKIE_PREFIX}* cookie to JavaScript: "${documentCookie}"`,
  ).toBe(false)

  // DISCRIMINATOR 2, and the one that IS the shipped defect. A cookie session has
  // exactly ONE authentication route: `GetSessionFromToken`'s version-2 branch reads
  // `access_token_<uuid>` out of the cookies, and its version-1 branch separately
  // refuses any session whose version is COOKIE_BASED. So the bearer ALONE must be
  // refused. That is precisely what every socket lane presented — a bearer with no
  // cookie — and why each of them was rejected 100% of the time while the suite stayed
  // green. Measured live: a cookie session answers 401 here, a legacy session 200.
  //
  // This fetch is from NODE, not the browser: it carries no cookie jar, which is the
  // whole point. A browser request would send the cookie and prove nothing.
  const bearerOnly = await fetch(new URL(BEARER_PROBE_PATH, baseURL ?? 'http://localhost:3001'), {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  expect(
    bearerOnly.status,
    `${label}: GET ${BEARER_PROBE_PATH} with ONLY the bearer "${parts[0]}:…" and no cookie was ` +
      `accepted (${bearerOnly.status}). A cookie session must refuse it — acceptance means this ` +
      'session authenticates from the header alone, i.e. it is a legacy header session.',
  ).toBe(401)

  return observation
}

/** The two legs, as the keys `expectCookieBasedSession` takes. */
export const SESSION_ROUTES = { register: 'register', signIn: 'signIn' } as const satisfies Record<string, SessionRoute>
