// eslint-disable-next-line @typescript-eslint/no-var-requires
const base = require('../../jest.config')

module.exports = {
  ...base,
  collectCoverageFrom: [
    // `HomeServer.ts` is the composition root the whole single-container and
    // LXC topology boots through, and it was outside the denominator entirely:
    // the file could lose every test and this workspace would still read 100 %.
    'src/Server/HomeServer.ts',
    'src/Server/HomeServerRuntime.ts',
    // A glob, not two literal paths: the realtime bridge is swapped per
    // topology (Redis today, in-process for the single container), and a new
    // bridge nobody remembered to list here would be invisible to this gate.
    'src/Server/WebSocket*.ts',
  ],
  coverageThreshold: {
    // The rest of the denominator keeps the shared 99 / 99 / 100 / 90 floor.
    // Jest subtracts path-keyed files from the global group, so this global
    // now judges `HomeServerRuntime.ts` and the WebSocket bridges only.
    ...base.coverageThreshold,
    // MEASURED at 7 suites / 136 tests (recorded in
    // `.orchestration/logs/t92/t92-w3-e2.md`):
    //   statements 69.15   branches 63.94   functions 48.14   lines 69.89
    // Each floor is that minus 1 pp. The shared floor cannot apply to this
    // file — it is ~30 pp below it — so a per-path entry is the only way to
    // gate it at all rather than not gate it.
    './src/Server/HomeServer.ts': {
      statements: 68.15,
      branches: 62.94,
      functions: 47.14,
      lines: 68.89,
    },
  },
}
