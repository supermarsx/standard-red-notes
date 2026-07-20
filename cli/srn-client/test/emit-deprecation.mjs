// Preload used by one test to emit a REAL DeprecationWarning inside a CLI child
// process, proving the harness's --no-deprecation actually suppresses it.
//
// This is the exact shape of the failure that turned CI red on Node 26: the
// resolver's module.register() is deprecated there, and src/polyfill.ts's own
// warning printer reformats such warnings to `DeprecationWarning: <message>`
// with no `(node:PID)` prefix — indistinguishable from CLI output, so it cannot
// be filtered after the fact and has to be suppressed at the source.
process.emitWarning('synthetic deprecation from the test harness', 'DeprecationWarning')
