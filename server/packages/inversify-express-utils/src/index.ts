import 'reflect-metadata'

import {
  All,
  ApplyMiddleware,
  Controller,
  Delete,
  Get,
  Next,
  Patch,
  Post,
  Put,
  Request as RequestParameter,
  Response as ResponseParameter,
  isHttpResponseSymbol,
  type HttpStatusCode,
} from '@inversifyjs/http-core'
import { InversifyExpressHttpAdapter, type ExpressMiddleware } from '@inversifyjs/http-express'
import express, { type Application, type NextFunction, type Request, type Response, type Router } from 'express'
import { type Container, type ResolutionContext, type ServiceIdentifier } from 'inversify'

type MiddlewareIdentifier = ServiceIdentifier<ExpressMiddleware>
type ConfigFunction = (app: Application) => void
type RouteDecorator = (path: string, ...middleware: MiddlewareIdentifier[]) => MethodDecorator
type LegacyExpressMiddleware = (request: Request, response: Response, next: NextFunction) => Promise<void> | void
type ControllerConstructor = new (...args: never[]) => unknown

export interface ControllerMethodMetadata {
  key: string | symbol
  middleware: MiddlewareIdentifier[]
  path: string
}

const controllers = new Set<ControllerConstructor>()
const methodMetadata = new WeakMap<ControllerConstructor, ControllerMethodMetadata[]>()
const explicitParameters = new WeakMap<object, Map<string | symbol, Set<number>>>()
const middlewareAdapterIdentifiers = new Map<MiddlewareIdentifier, ServiceIdentifier<ExpressMiddleware>>()

const getMiddlewareAdapterIdentifier = (identifier: MiddlewareIdentifier): ServiceIdentifier<ExpressMiddleware> => {
  let adapterIdentifier = middlewareAdapterIdentifiers.get(identifier)
  if (adapterIdentifier === undefined) {
    adapterIdentifier = Symbol('LegacyExpressMiddlewareAdapter')
    middlewareAdapterIdentifiers.set(identifier, adapterIdentifier)
  }

  return adapterIdentifier
}

const adaptMiddleware = (middleware: unknown): ExpressMiddleware => {
  if (typeof middleware === 'function') {
    const handler = middleware as LegacyExpressMiddleware
    return {
      execute: (request, response, next) => handler(request, response, next),
    }
  }

  if (
    typeof middleware === 'object' &&
    middleware !== null &&
    'execute' in middleware &&
    typeof middleware.execute === 'function'
  ) {
    return middleware as ExpressMiddleware
  }

  throw new TypeError('HTTP middleware must be an Express function or expose execute()')
}

const markExplicitParameter = (target: object, key: string | symbol, index: number): void => {
  let methods = explicitParameters.get(target)
  if (methods === undefined) {
    methods = new Map()
    explicitParameters.set(target, methods)
  }

  let indexes = methods.get(key)
  if (indexes === undefined) {
    indexes = new Set()
    methods.set(key, indexes)
  }

  indexes.add(index)
}

const applyImplicitParameters = (
  target: object,
  key: string | symbol,
  descriptor: PropertyDescriptor | undefined,
): void => {
  const reflectedTypes = Reflect.getMetadata('design:paramtypes', target, key) as unknown[] | undefined
  const declaredCount = typeof descriptor?.value === 'function' ? descriptor.value.length : 0
  const parameterCount = reflectedTypes?.length ?? declaredCount
  const explicitlyDecorated = explicitParameters.get(target)?.get(key) ?? new Set<number>()
  const decorators = [RequestParameter(), ResponseParameter(), Next()]

  for (let index = 0; index < Math.min(parameterCount, decorators.length); index += 1) {
    if (!explicitlyDecorated.has(index)) {
      decorators[index](target, key, index)
    }
  }
}

const createRouteDecorator = (route: (path?: string) => MethodDecorator): RouteDecorator => {
  return (path: string, ...middleware: MiddlewareIdentifier[]): MethodDecorator => {
    return (target, key, descriptor): void => {
      applyImplicitParameters(target, key, descriptor)
      route(path)(target, key, descriptor)
      if (middleware.length > 0) {
        ApplyMiddleware(...middleware.map(getMiddlewareAdapterIdentifier))(target, key, descriptor)
      }

      const constructor = target.constructor as ControllerConstructor
      const metadata = methodMetadata.get(constructor) ?? []
      metadata.push({ key, middleware, path })
      methodMetadata.set(constructor, metadata)
    }
  }
}

export const all = createRouteDecorator(All)
export const httpDelete = createRouteDecorator(Delete)
export const httpGet = createRouteDecorator(Get)
export const httpPatch = createRouteDecorator(Patch)
export const httpPost = createRouteDecorator(Post)
export const httpPut = createRouteDecorator(Put)

export const controller = (path: string, ...middleware: MiddlewareIdentifier[]): ClassDecorator => {
  return (target): void => {
    Controller(path)(target)
    if (middleware.length > 0) {
      ApplyMiddleware(...middleware.map(getMiddlewareAdapterIdentifier))(target)
    }
    controllers.add(target as unknown as new (...args: never[]) => unknown)
  }
}

export const response = (): ParameterDecorator => {
  return (target, key, index): void => {
    if (key === undefined) {
      throw new TypeError('The response decorator can only be used on controller methods')
    }
    markExplicitParameter(target, key, index)
    ResponseParameter()(target, key, index)
  }
}

export const getControllerMethodMetadata = (target: ControllerConstructor): ControllerMethodMetadata[] => {
  return [...(methodMetadata.get(target) ?? [])]
}

abstract class CompatibilityResult {
  readonly [isHttpResponseSymbol] = true as const

  protected constructor(
    readonly statusCode: HttpStatusCode,
    readonly body?: unknown,
  ) {}

  async executeAsync(): Promise<this> {
    return this
  }
}

// This legacy namespace must remain usable in both value and type positions by existing controllers.
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace results {
  export class JsonResult extends CompatibilityResult {
    readonly json: unknown

    constructor(json: unknown, statusCode: number) {
      super(statusCode as HttpStatusCode, json)
      this.json = json
    }
  }

  export class StatusCodeResult extends CompatibilityResult {
    constructor(statusCode: number) {
      super(statusCode as HttpStatusCode)
    }
  }

  export class OkResult extends StatusCodeResult {
    constructor() {
      super(200)
    }
  }

  export class BadRequestResult extends StatusCodeResult {
    constructor() {
      super(400)
    }
  }

  export class BadRequestErrorMessageResult extends CompatibilityResult {
    constructor(readonly message: string) {
      super(400 as HttpStatusCode, message)
    }
  }

  export class NotFoundResult extends StatusCodeResult {
    constructor() {
      super(404)
    }
  }
}

export class BaseHttpController {
  protected ok(): results.OkResult
  protected ok(content: unknown): results.JsonResult
  protected ok(content?: unknown): results.OkResult | results.JsonResult {
    return content === undefined ? new results.OkResult() : new results.JsonResult(content, 200)
  }

  protected badRequest(): results.BadRequestResult
  protected badRequest(message: string): results.BadRequestErrorMessageResult
  protected badRequest(message?: string): results.BadRequestResult | results.BadRequestErrorMessageResult {
    return message === undefined ? new results.BadRequestResult() : new results.BadRequestErrorMessageResult(message)
  }

  protected notFound(): results.NotFoundResult {
    return new results.NotFoundResult()
  }

  protected statusCode(statusCode: number): results.StatusCodeResult {
    return new results.StatusCodeResult(statusCode)
  }

  protected json(content: unknown, statusCode = 200): results.JsonResult {
    return new results.JsonResult(content, statusCode)
  }
}

export abstract class BaseMiddleware implements ExpressMiddleware {
  abstract handler(request: Request, response: Response, next: NextFunction): Promise<void> | void

  execute(request: Request, response: Response, next: NextFunction): Promise<void> | void {
    return this.handler(request, response, next)
  }
}

export class InversifyExpressServer {
  private readonly app: Application
  private configFunction?: ConfigFunction
  private errorConfigFunction?: ConfigFunction
  private built = false

  constructor(
    private readonly container: Container,
    _customRouter?: Router | null,
    _routingConfig?: unknown,
    customApp?: Application | null,
    _authProvider?: (new () => unknown) | null,
    _forceControllers = true,
  ) {
    this.app = customApp ?? express()
  }

  setConfig(configFunction: ConfigFunction): this {
    this.configFunction = configFunction
    return this
  }

  setErrorConfig(configFunction: ConfigFunction): this {
    this.errorConfigFunction = configFunction
    return this
  }

  async build(): Promise<Application> {
    if (this.built) {
      throw new Error('The HTTP server has already been built')
    }

    this.configFunction?.(this.app)

    for (const target of controllers) {
      if (!this.container.isBound(target)) {
        this.container.bind(target).toSelf()
      }
    }

    for (const [identifier, adapterIdentifier] of middlewareAdapterIdentifiers) {
      if (this.container.isBound(identifier) && !this.container.isBound(adapterIdentifier)) {
        this.container
          .bind<ExpressMiddleware>(adapterIdentifier)
          .toDynamicValue((context: ResolutionContext) => adaptMiddleware(context.get(identifier)))
      }
    }

    const adapter = new InversifyExpressHttpAdapter(this.container, { logger: false }, this.app)
    await adapter.build()
    this.errorConfigFunction?.(this.app)
    this.built = true

    return this.app
  }
}
