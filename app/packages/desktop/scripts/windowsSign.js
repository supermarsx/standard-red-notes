const { execFileSync } = require('child_process')

async function windowsSign(configuration, dependencies = {}) {
  const env = dependencies.env || process.env
  const log = dependencies.log || console.log
  const keypairAlias = env.SM_KEYPAIR_ALIAS
  if (!keypairAlias) {
    const message = 'Windows release authenticity credential missing: SM_KEYPAIR_ALIAS'
    if (env.REQUIRE_DESKTOP_AUTHENTICITY === 'true') {
      throw new Error(message)
    }
    log(`Skipping Windows signing for this non-publishing build: ${message}`)
    return
  }

  if (!configuration.path) {
    throw new Error('Windows signing hook received no artifact path')
  }

  const run = dependencies.execFileSync || execFileSync
  run('smctl', ['sign', '--keypair-alias', keypairAlias, '--input', String(configuration.path), '--verbose'], {
    stdio: 'inherit',
  })
}

exports.default = windowsSign
exports.windowsSign = windowsSign
