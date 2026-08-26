const { execFileSync } = require('child_process')
const path = require('path')
const { merge } = require('webpack-merge')
const config = require('./web.webpack.config.js')
const mergeWithEnvDefaults = require('./web.webpack-defaults.js')
const ReactRefreshWebpackPlugin = require('@pmmmwh/react-refresh-webpack-plugin')

const DEFAULT_PORT = 3001
const DEPLOYMENT_MARKER_PATH = '/.well-known/srn-deployment.json'
const preflightScript = path.resolve(__dirname, '../../../scripts/detect-running-instance.mjs')

/**
 * The dev server is only interesting to the preflight when it is actually going
 * to bind a socket. `yarn watch` runs this same config purely to compile, so it
 * must not be blocked by whatever happens to hold port 3001.
 */
function isServing() {
  return process.env.WEBPACK_SERVE === 'true' || /webpack-dev-server/.test(process.argv[1] || '')
}

/**
 * Ask scripts/detect-running-instance.mjs what port to bind and who this build
 * is, before webpack-dev-server binds anything.
 *
 * This exists because the failure it prevents is invisible: if a stale dev
 * server from an earlier run still holds 3001, the browser loads it happily and
 * you spend the next hour debugging code that is not running. The preflight
 * refuses to launch in that case rather than quietly picking 3002, because
 * moving ports leaves the open browser tab pointed at the stale instance — the
 * same wrong build, now with a launch that looked like it succeeded.
 *
 * The report goes to stderr (inherited, so you see it); the plan comes back on
 * stdout. Set SRN_SKIP_LAUNCH_PREFLIGHT=1 to bypass entirely.
 */
function resolveLaunchPlan(argv) {
  const requestedPort = argv.port || DEFAULT_PORT
  const fallback = { port: requestedPort, marker: null }

  if (!isServing() || process.env.SRN_SKIP_LAUNCH_PREFLIGHT === '1') {
    return fallback
  }

  const args = [preflightScript, '--port', String(requestedPort), '--emit-launch-plan']
  // An explicitly requested --port is the developer's decision, so honour it:
  // detect and report on that port, but never silently relocate off it.
  args.push(argv.port ? '--no-adjust' : '--adjust')

  let stdout
  try {
    stdout = execFileSync(process.execPath, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsHide: true,
    })
  } catch (error) {
    if (error && typeof error.status === 'number' && error.status === 1) {
      throw new Error(
        `Refusing to start the dev server: port ${requestedPort} is not safely available (see the preflight report above). ` +
          'Use the instance that is already running, stop it, or pass an explicit --port.',
      )
    }
    // A preflight that cannot run at all must not become a launch blocker.
    process.stderr.write(`Launch preflight could not run (${error && error.message}); continuing unchecked.\n`)
    return fallback
  }

  try {
    const plan = JSON.parse(stdout)
    return { port: plan.port || requestedPort, marker: plan.marker || null }
  } catch {
    return fallback
  }
}

/**
 * Publish the same deployment marker the built images publish. Without it a dev
 * server is unidentifiable from the outside: a probe sees "some HTTP server" and
 * cannot tell a stale instance of THIS app from an unrelated project's dev
 * server on the same port. `dev-dirty` in the version field is honest about the
 * working tree not matching the commit.
 */
function deploymentMarkerMiddleware(marker) {
  const body = JSON.stringify(marker || { revision: '', version: 'unstamped' })
  return {
    name: 'srn-deployment-marker',
    path: DEPLOYMENT_MARKER_PATH,
    middleware: (_request, response) => {
      response.setHeader('Content-Type', 'application/json')
      response.setHeader('Cache-Control', 'no-store')
      response.end(body)
    },
  }
}

module.exports = (env, argv) => {
  const plan = resolveLaunchPlan(argv)
  const port = plan.port
  mergeWithEnvDefaults(env)
  return merge(config(env, argv), {
    mode: 'development',
    devtool: process.env.BUILD_TARGET === 'extension' ? 'cheap-module-source-map' : 'inline-source-map',
    optimization: {
      minimize: false,
    },
    output: {
      publicPath: '/',
    },
    plugins: [new ReactRefreshWebpackPlugin()],
    devServer: {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Security-Policy':
          "default-src https: 'self'; base-uri 'self'; child-src * blob:; connect-src * blob:; font-src * data:; form-action 'self'; frame-ancestors * file:; frame-src * blob:; img-src 'self' * data: blob:; manifest-src 'self'; media-src 'self' blob:; object-src 'none'; script-src 'self' 'sha256-r26E+iPOhx7KM7cKn4trOSoD8u5E7wL7wwJ8UrR+rGs=' 'unsafe-eval' 'wasm-unsafe-eval'; style-src *;",
      },
      hot: true,
      static: './dist',
      port,
      historyApiFallback: true,
      setupMiddlewares: (middlewares) => {
        middlewares.unshift(deploymentMarkerMiddleware(plan.marker))
        return middlewares
      },
      devMiddleware: {
        writeToDisk: argv.writeToDisk,
      },
    },
  })
}
