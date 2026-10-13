/**
 * Standard Red Notes: construct a class with EVERY constructor parameter
 * supplied -- the optional ones included -- or do not compile.
 *
 * *** WHY THIS EXISTS. *** The all-in-one container builds its controllers by
 * position (`new BaseAdminController(a, b, c, ...)`), and the controllers declare
 * their newer dependencies as optional so that older specs keep compiling. Put
 * those two together and a dependency nobody passes is not an error anywhere: the
 * parameter is optional, so `tsc` accepts its absence and accepts the literal
 * `undefined` just as readily. `BaseAdminController` was built that way with
 * `undefined` in SIXTEEN positions, and what that came to on a running all-in-one
 * was a 500 from `GET /v1/admin/users/:uuid/effective-permissions` for every
 * account and from every request the Groups & roles tab makes, while the
 * multi-container build -- which injects the same sixteen through the annotated
 * controller -- answered 200 and kept every gate green.
 *
 * `Required<...>` over the constructor's own parameter list takes the question
 * marks off, and with them the `undefined` each one allowed. So through this
 * function:
 *
 *   - a constructor that GAINS a parameter fails to compile here until the
 *     container passes it (the argument list is one element short);
 *   - a literal `undefined` in any position fails to compile.
 *
 * It constrains the composition root only. The constructors stay as they are, so
 * a spec may still build a controller with the handful of dependencies it needs.
 *
 * What it cannot see is a dependency that is supplied and is `undefined` at run
 * time anyway (a cast, or a binding that resolves to nothing); that is what
 * `HomeServerAdminRbacWiring.integration.spec.ts` is for.
 */
export function constructWithEveryDependency<Dependencies extends unknown[], Instance>(
  classToConstruct: new (...dependencies: Dependencies) => Instance,
  ...dependencies: NoInfer<Required<Dependencies>>
): Instance {
  return new classToConstruct(...dependencies)
}
