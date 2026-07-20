// Preload (`node --import`) that installs the ./x.js -> ./x.ts resolution hook.
// See resolve-ts-hooks.mjs for why it exists.
//
// registerHooks(), NOT register(): register() is deprecated as of Node 26 and
// emits DEP0205 on stderr. Because these tests run the CLI as a child process
// and assert on its exact stderr, that warning was indistinguishable from CLI
// output and turned 10 tests red on the runner while passing on Node 24.
// registerHooks runs the hooks in-thread and emits nothing.
import { registerHooks } from 'node:module'

import { resolve } from './resolve-ts-hooks.mjs'

registerHooks({ resolve })
