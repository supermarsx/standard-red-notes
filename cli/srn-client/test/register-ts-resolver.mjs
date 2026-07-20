// Preload (`node --import`) that installs the ./x.js -> ./x.ts resolution hook.
// See resolve-ts-hooks.mjs for why it exists.
//
// Deliberately module.register(), NOT module.registerHooks(), even though
// register() is deprecated (DEP0205) as of Node 26.
//
// registerHooks() runs in-thread and applies to CommonJS require() as well as
// to import. That changes how @standardnotes/sncrypto-web's dependency graph
// resolves, and `@standardnotes/sncrypto-common` then fails to load at all
// ("does not provide an export named 'SodiumConstant'"), taking 30 tests with
// it. srn-server's resolver has no such graph and does use registerHooks.
//
// The deprecation notice this prints on the child's stderr is handled where it
// belongs: harness.ts splits Node's own `(node:PID)` notices out of the CLI's
// stderr, so the assertions no longer depend on the Node version either way.
// Node 26 CI confirms register() still FUNCTIONS there — the only fallout was
// the warning text.
import { register } from 'node:module'

register('./resolve-ts-hooks.mjs', import.meta.url)
