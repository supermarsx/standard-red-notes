import { DirectCallServiceProxy } from '../DirectCall/DirectCallServiceProxy'
import { HttpServiceProxy } from '../Http/HttpServiceProxy'
import { ServiceProxyInterface } from './ServiceProxyInterface'

// ---------------------------------------------------------------------------
// A NARROWER IMPLEMENTATION IS NOT A TYPE ERROR, AND THAT COST 100 % OF
// COLLABORATION ON EVERY SINGLE-CONTAINER DEPLOYMENT.
//
// `ServiceProxyInterface` declares every `call*Server` method with FOUR
// parameters, the fourth being `payload`. `DirectCallServiceProxy.callSyncingServer`
// declared THREE. TypeScript accepts that -- a function that ignores trailing
// arguments is assignable to one that declares them -- so `yarn build`, `yarn
// lint` and `tsc --noEmit` were all green over a proxy that silently threw the
// body away.
//
// `CollaborationAuthorizationService` is the one caller whose body exists ONLY
// as that argument: it calls `POST items/collaboration-authorization` with
// `{ itemUuid }` while the request it forwards carries the client's
// `{ noteUuid, ... }` instead. So `BaseItemsController.authorizeCollaboration`
// read `request.body.itemUuid`, found `undefined`, and FAILED CLOSED -- every
// note refused, a personal note owned by the caller included (`6e18e3a5`).
//
// Nothing in the suite could see it, because every existing spec drives these
// methods through the interface and therefore never asks how many parameters
// the implementation admits to. `Function.prototype.length` does: it counts the
// parameters declared before the first default or rest parameter, and `payload?:
// T` compiles to a plain parameter. So the one question no type checker will
// ask is asked here, as data.
//
// This is a STRUCTURAL guard for the whole class, not a second test of the fix.
// ---------------------------------------------------------------------------

/** Every `call*Server` method the interface declares, with its declared width. */
const PROXY_METHODS: Array<keyof ServiceProxyInterface> = [
  'callEmailServer',
  'callAuthServer',
  'callAuthServerWithLegacyFormat',
  'callRevisionsServer',
  'callSyncingServer',
  'callLegacySyncingServer',
  'callPaymentsServer',
  'callWebSocketServer',
]

const DECLARED_WIDTH = 4

function arity(prototype: object, method: string): number {
  const implementation = (prototype as Record<string, unknown>)[method]
  if (typeof implementation !== 'function') {
    throw new Error(`${method} is not implemented`)
  }
  return implementation.length
}

function narrowMethods(prototype: object): string[] {
  return PROXY_METHODS.filter((method) => arity(prototype, method) < DECLARED_WIDTH).sort()
}

describe('ServiceProxyInterface implementation arity', () => {
  it('CONTROL: the probe actually discriminates a narrowed method', () => {
    // Exactly the shape the defect had: the fourth parameter simply absent.
    class Narrowed {
      async callSyncingServer(_request: never, _response: never, _methodIdentifier: string): Promise<void> {}
      async callAuthServer(
        _request: never,
        _response: never,
        _methodIdentifier: string,
        _payload?: Record<string, unknown> | string,
      ): Promise<void> {}
    }

    expect(arity(Narrowed.prototype, 'callSyncingServer')).toBe(3)
    expect(arity(Narrowed.prototype, 'callAuthServer')).toBe(DECLARED_WIDTH)
    expect(arity(Narrowed.prototype, 'callSyncingServer')).toBeLessThan(DECLARED_WIDTH)
  })

  it('HttpServiceProxy declares the payload on every proxied method', () => {
    // The reference implementation. Every method here forwards `payload` into
    // `callServer`, so a narrowing on this side would break the multi-container
    // topology the same way.
    expect(narrowMethods(HttpServiceProxy.prototype)).toEqual([])
  })

  it('REGRESSION (6e18e3a5): DirectCallServiceProxy.callSyncingServer declares the payload', () => {
    // Reverting the fix to `callSyncingServer(request, response, methodIdentifier)`
    // -- which is type-valid and was green on every other gate -- turns this red.
    expect(arity(DirectCallServiceProxy.prototype, 'callSyncingServer')).toBe(DECLARED_WIDTH)
  })

  // The remaining narrow methods are PINNED rather than asserted away, so that
  // neither a new narrowing nor a repair happens unnoticed.
  //
  // Four of them (`callEmailServer`, `callAuthServerWithLegacyFormat`,
  // `callLegacySyncingServer`, `callPaymentsServer`) answer a fixed 400 on this
  // topology and read no argument at all, so the payload is genuinely
  // immaterial to them.
  //
  // `callAuthServer`, `callRevisionsServer` and `callWebSocketServer` DO
  // forward to a real service, and `ValetTokenFileResourceAuthorizer` passes a
  // payload to `callAuthServer` (`POST valet-tokens`) exactly the way
  // `CollaborationAuthorizationService` passes one to `callSyncingServer`. That
  // path does not run on this topology today -- the home server composes
  // `CanonicalHomeServerFileResourceAuthorizer` instead, and the multi-container
  // stack uses `HttpServiceProxy`, whose arity is full -- so it is a latent
  // hazard rather than a live defect, and repairing it belongs with the owner of
  // that proxy. Recording it in a gate is the point: the same shape of defect
  // was invisible for weeks precisely because nothing wrote it down.
  it('records which DirectCall methods are still narrower than the interface declares', () => {
    expect(narrowMethods(DirectCallServiceProxy.prototype)).toEqual(
      [
        'callAuthServer',
        'callAuthServerWithLegacyFormat',
        'callEmailServer',
        'callLegacySyncingServer',
        'callPaymentsServer',
        'callRevisionsServer',
        'callWebSocketServer',
      ].sort(),
    )
  })
})
