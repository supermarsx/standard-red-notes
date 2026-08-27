import 'reflect-metadata'

import { injectable, inject, optional } from 'inversify'

import * as barrel from './index'

/**
 * Standard Red Notes: every `@controller` must be CONSTRUCTIBLE by Inversify.
 *
 * `inversify-express-utils` binds each decorated controller with
 * `container.bind(target).toSelf()` and resolves it PER REQUEST, so Inversify —
 * not TypeScript — supplies every constructor argument. The build runs with
 * `emitDecoratorMetadata`, which means a constructor parameter with no
 * `@inject()` does not simply arrive as `undefined`: Inversify falls back to the
 * emitted `design:paramtypes` and treats the parameter's own CLASS as a service
 * identifier to resolve. Nothing binds an arbitrary collaborator class, so
 * resolution throws before the handler ever runs and the route answers 500.
 *
 * A TypeScript default value (`private readonly x: Thing = theSingleton`) looks
 * like it covers this and does not — Inversify never reaches the default.
 *
 * This shipped once, on `SyncWebSocketController`, and turned the public
 * `GET /v1/sockets/sync/capabilities` probe into a 500 in production. Nothing
 * caught it: every controller spec builds instances with `new Controller(...)`
 * and passes its own fakes, and the route sweep in `RouteDispatch.spec.ts` uses
 * `Object.create(prototype)` deliberately, so it "keeps this spec independent of
 * each controller's constructor signature" — which is exactly the signature that
 * was broken. No test in the package resolved a controller through a container.
 *
 * This spec closes that hole for every controller at once, present and future,
 * without needing a container that can satisfy each one's real dependencies: it
 * asserts on the injection metadata Inversify itself planned from.
 */

/** The metadata Inversify 8 records per class; `value` is the resolved service identifier. */
const CLASS_METADATA_KEY = '@inversifyjs/core/classMetadataReflectKey'

type InversifyClassMetadata = {
  constructorArguments?: { optional?: boolean; value?: unknown }[]
}

const describeIdentifier = (value: unknown): string => {
  if (typeof value === 'symbol') {
    return value.toString()
  }
  if (typeof value === 'function') {
    return `class ${value.name}`
  }

  return String(value)
}

/**
 * Returns one message per constructor parameter that Inversify would try to
 * resolve by its emitted class rather than by an explicit `@inject()` identifier.
 */
const findImplicitlyInjectedParameters = (target: object, name: string): string[] => {
  const metadata = Reflect.getMetadata(CLASS_METADATA_KEY, target) as InversifyClassMetadata | undefined
  const constructorArguments = metadata?.constructorArguments ?? []

  return constructorArguments.flatMap((argument, index) => {
    if (typeof argument.value === 'symbol') {
      return []
    }

    return [
      `${name} constructor parameter ${index} resolves ${describeIdentifier(argument.value)}, ` +
        'which came from design:paramtypes rather than an explicit @inject(TYPES.…). ' +
        'Inversify will try to resolve it as a service identifier and throw, making every route on ' +
        'this controller answer 500. Add @inject(TYPES.…), plus @optional() if nothing binds it.',
    ]
  })
}

const controllerEntries = Object.entries(barrel).filter(
  (entry): entry is [string, object] =>
    typeof entry[1] === 'function' &&
    Reflect.getMetadata('@inversifyjs/http-core/controller/controllerMethodMetadataReflectKey', entry[1]) !== undefined,
)

describe('controller constructor injection', () => {
  it('covers every controller the barrel exports', () => {
    // Guards against the barrel or the metadata key changing underneath this
    // spec and silently reducing it to a no-op that asserts over an empty list.
    expect(controllerEntries.length).toBeGreaterThan(20)
  })

  it.each(controllerEntries)('%s declares an explicit @inject() for every constructor parameter', (name, target) => {
    expect(findImplicitlyInjectedParameters(target, name)).toEqual([])
  })

  /**
   * Proves the check above can actually fail. Without this, a change to
   * Inversify's metadata shape would turn the whole spec green-by-vacuity while
   * the defect it exists to catch sailed through again.
   */
  it('detects an undecorated constructor parameter', () => {
    class Collaborator {}

    @injectable()
    class ControllerWithUndecoratedParameter {
      constructor(readonly collaborator: Collaborator = new Collaborator()) {}
    }

    expect(findImplicitlyInjectedParameters(ControllerWithUndecoratedParameter, 'Fixture')).toEqual([
      expect.stringContaining('class Collaborator'),
    ])
  })

  it('accepts an explicitly injected optional parameter', () => {
    class Collaborator {}
    const IDENTIFIER = Symbol.for('ControllerInjectionSpec_Collaborator')

    @injectable()
    class ControllerWithInjectedParameter {
      constructor(@inject(IDENTIFIER) @optional() readonly collaborator?: Collaborator) {}
    }

    expect(findImplicitlyInjectedParameters(ControllerWithInjectedParameter, 'Fixture')).toEqual([])
  })
})
