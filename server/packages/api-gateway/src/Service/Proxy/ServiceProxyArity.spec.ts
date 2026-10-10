import 'reflect-metadata'

import * as fs from 'fs'
import * as path from 'path'
import * as ts from 'typescript'

import { DirectCallServiceProxy } from '../DirectCall/DirectCallServiceProxy'
import { GRPCServiceProxy } from '../gRPC/GRPCServiceProxy'
import { HttpServiceProxy } from '../Http/HttpServiceProxy'

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
// `CollaborationAuthorizationService` is one caller whose body exists ONLY as
// that argument: it calls `POST items/collaboration-authorization` with
// `{ itemUuid }` while the request it forwards carries the client's
// `{ noteUuid, ... }` instead. So `BaseItemsController.authorizeCollaboration`
// read `request.body.itemUuid`, found `undefined`, and FAILED CLOSED -- every
// note refused, a personal note owned by the caller included (`6e18e3a5`).
// `callAuthServer` had the identical shape one method over, and
// `SessionsController.deleteSession` is its `{ uuid: request.params.uuid }`
// caller: `DELETE /v1/sessions/:uuid` answered `400 Please provide the session
// identifier.` on this topology for any client that did not ALSO repeat the
// uuid in the request body.
//
// Nothing in the suite could see either one, because every existing spec drives
// these methods through the interface and therefore never asks how many
// parameters the implementation admits to. `Function.prototype.length` does: it
// counts the parameters declared before the first default or rest parameter,
// and `payload?: T` compiles to a plain parameter. So the one question no type
// checker will ask is asked here, as data.
//
// THREE THINGS ARE DERIVED FROM SOURCE RATHER THAN RESTATED, because a
// hand-maintained list is exactly how the second instance of this defect went
// unrecorded for as long as it did:
//
//  1. the method list and each method's WIDTH come from parsing
//     `ServiceProxyInterface.ts`, so widening the interface puts every
//     implementation in breach until it is widened too;
//  2. the set of IMPLEMENTATIONS comes from scanning this package's sources for
//     `implements ServiceProxyInterface`, so a fourth proxy fails this gate
//     until it is registered below and measured;
//  3. nothing is "pinned" or waived. Every method of every implementation is
//     held to the declared width, including the four that answer a fixed 400
//     and read no argument at all -- "this one happens not to need it" is the
//     reasoning that left the hole open.
//
// WHAT THIS GATE DOES NOT PROVE: that a declared parameter is USED. An
// implementation can accept `payload` and drop it on the floor, and that is a
// legitimate choice for the 400 stubs and for `callWebSocketServer`, which
// forwards no request anywhere. The behavioural half lives in
// `DirectCall/DirectCallServiceProxy.spec.ts`, which asserts that the receiving
// service observed the payload as its request body.
// ---------------------------------------------------------------------------

const INTERFACE_NAME = 'ServiceProxyInterface'

/** `src/Service`, the tree every proxy implementation lives in. */
const SOURCE_ROOT = path.resolve(__dirname, '..')
const INTERFACE_FILE = path.resolve(__dirname, `${INTERFACE_NAME}.ts`)

/**
 * Every implementation this gate measures. The scan below fails if the tree
 * holds one that is missing from here, so adding a proxy cannot quietly opt out
 * of the measurement.
 */
const IMPLEMENTATIONS: Array<{ name: string; prototype: object }> = [
  { name: 'DirectCallServiceProxy', prototype: DirectCallServiceProxy.prototype },
  { name: 'GRPCServiceProxy', prototype: GRPCServiceProxy.prototype },
  { name: 'HttpServiceProxy', prototype: HttpServiceProxy.prototype },
]

function parseSource(file: string): ts.SourceFile {
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
}

/** Each method the interface declares, mapped to the number of parameters it declares. */
function readDeclaredWidths(): Map<string, number> {
  const widths = new Map<string, number>()
  parseSource(INTERFACE_FILE).forEachChild((node) => {
    if (!ts.isInterfaceDeclaration(node) || node.name.text !== INTERFACE_NAME) {
      return
    }
    for (const member of node.members) {
      if (ts.isMethodSignature(member) && ts.isIdentifier(member.name)) {
        widths.set(member.name.text, member.parameters.length)
      }
    }
  })
  return widths
}

/**
 * The local name(s) `ServiceProxyInterface` is reachable by in one file. An
 * aliased import (`import { ServiceProxyInterface as SPI }`) must not be able
 * to hide an implementation from the scan.
 */
function localNamesForInterface(source: ts.SourceFile, file: string): Set<string> {
  const names = new Set<string>()
  if (file === INTERFACE_FILE) {
    names.add(INTERFACE_NAME)
  }
  source.forEachChild((node) => {
    if (!ts.isImportDeclaration(node) || node.importClause === undefined) {
      return
    }
    const bindings = node.importClause.namedBindings
    if (bindings === undefined || !ts.isNamedImports(bindings)) {
      return
    }
    for (const element of bindings.elements) {
      if ((element.propertyName?.text ?? element.name.text) === INTERFACE_NAME) {
        names.add(element.name.text)
      }
    }
  })
  return names
}

function typescriptSourcesUnder(directory: string): string[] {
  const files: string[] = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.resolve(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...typescriptSourcesUnder(absolute))
      continue
    }
    // Specs are excluded on purpose: a test double is allowed to implement the
    // interface however the test it serves needs.
    if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      files.push(absolute)
    }
  }
  return files
}

/** Every class in the tree whose `implements` clause names the interface. */
function implementationsInTree(): string[] {
  const classNames: string[] = []
  for (const file of typescriptSourcesUnder(SOURCE_ROOT)) {
    const text = fs.readFileSync(file, 'utf8')
    // A class cannot implement the interface without the identifier appearing
    // in its file, so this prefilter cannot hide one.
    if (!text.includes(INTERFACE_NAME)) {
      continue
    }
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const localNames = localNamesForInterface(source, file)
    source.forEachChild((node) => {
      if (!ts.isClassDeclaration(node) || node.name === undefined) {
        return
      }
      for (const clause of node.heritageClauses ?? []) {
        if (clause.token !== ts.SyntaxKind.ImplementsKeyword) {
          continue
        }
        for (const implemented of clause.types) {
          if (ts.isIdentifier(implemented.expression) && localNames.has(implemented.expression.text)) {
            classNames.push((node.name as ts.Identifier).text)
          }
        }
      }
    })
  }
  return classNames.sort()
}

function arity(prototype: object, method: string): number {
  const implementation = (prototype as Record<string, unknown>)[method]
  if (typeof implementation !== 'function') {
    throw new Error(`${method} is not implemented`)
  }
  return implementation.length
}

function arityTable(prototype: object, methods: Iterable<string>): Record<string, number> {
  const table: Record<string, number> = {}
  for (const method of methods) {
    table[method] = arity(prototype, method)
  }
  return table
}

const DECLARED_WIDTHS = readDeclaredWidths()

describe('ServiceProxyInterface implementation arity', () => {
  describe('CONTROL: the measurement is not vacuous', () => {
    /**
     * The failure mode this gate is most exposed to is its OWN denominator
     * emptying out: a rename, a parse that finds nothing, a walker that returns
     * no files, and every arity assertion below passes over nothing at all.
     * `expect(x).toEqual(y)` over two empty objects is green.
     */
    it('the interface source parses into the widths it declares', () => {
      expect(Object.fromEntries(DECLARED_WIDTHS)).toEqual({
        callEmailServer: 4,
        callAuthServer: 4,
        callAuthServerWithLegacyFormat: 4,
        callRevisionsServer: 4,
        callSyncingServer: 4,
        callLegacySyncingServer: 4,
        callPaymentsServer: 4,
        callWebSocketServer: 4,
        validateSession: 1,
      })
    })

    it('the probe actually discriminates a narrowed method', () => {
      // Exactly the shape both defects had: the fourth parameter simply absent.
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
      expect(arity(Narrowed.prototype, 'callAuthServer')).toBe(4)
      expect(arity(Narrowed.prototype, 'callSyncingServer')).toBeLessThan(
        DECLARED_WIDTHS.get('callSyncingServer') as number,
      )
    })

    it('the probe reports a method that is not implemented at all rather than scoring it', () => {
      expect(() => arity({}, 'callAuthServer')).toThrow('callAuthServer is not implemented')
    })

    it('the tree scan finds every implementation this gate measures, and no others', () => {
      // An unregistered fourth proxy fails HERE, before it can be narrow
      // without anyone noticing.
      expect(implementationsInTree()).toEqual(IMPLEMENTATIONS.map(({ name }) => name).sort())
    })
  })

  /**
   * The whole gate, in one assertion per implementation: every method the
   * interface declares, at the width the interface declares it.
   *
   * REGRESSIONS THIS TURNS RED. Reverting either fix to its three-parameter
   * form -- both type-valid, both green on every other gate -- fails this:
   *   - `callSyncingServer(request, response, methodIdentifier)`  (`6e18e3a5`)
   *   - `callAuthServer(request, response, methodIdentifier)`
   */
  it.each(IMPLEMENTATIONS)('$name declares every parameter the interface declares', ({ prototype }) => {
    expect(arityTable(prototype, DECLARED_WIDTHS.keys())).toEqual(Object.fromEntries(DECLARED_WIDTHS))
  })
})
