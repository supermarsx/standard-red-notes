// Preload (`node --import`) that installs the ./x.js -> ./x.ts resolution hook.
// See resolve-ts-hooks.mjs for why it exists.
import { register } from 'node:module'

register('./resolve-ts-hooks.mjs', import.meta.url)
