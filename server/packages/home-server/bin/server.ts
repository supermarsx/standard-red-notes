import { safeErrorLogMetadata } from '@standardnotes/domain-core'
import { Env } from '../src/Bootstrap/Env'
import { boundedBootFailureText, HomeServer } from '../src/Server/HomeServer'

/**
 * Standard Red Notes: fail-fast global crash handlers, matching the
 * api-gateway's. A genuinely unhandled rejection or uncaught exception leaves
 * the process in an unknown state, so log one clear FATAL line (redacted
 * classification only: type, code, status — never the message) and exit
 * non-zero so the supervisor restarts us. Node's default already crashes on an
 * unhandled rejection; what this adds is a line that names the event, so a
 * crash-loop is VISIBLE and attributable instead of a bare stack on stderr.
 */
function installFatalHandlers(target: NodeJS.Process): void {
  target.on('unhandledRejection', (reason: unknown) => {
    console.error('FATAL unhandledRejection.', safeErrorLogMetadata(reason))
    target.exit(1)
  })
  target.on('uncaughtException', (error: Error) => {
    console.error('FATAL uncaughtException.', safeErrorLogMetadata(error))
    target.exit(1)
  })
}

if (process.argv.length === 3 && process.argv[2] === '--srn-release-self-test') {
  process.stdout.write(`srn-native-self-test-v1 ${process.platform} ${process.arch}\n`)
} else {
  installFatalHandlers(process)

  const homeServer = new HomeServer()

  const env: Env = new Env()
  env.load()

  try {
    Promise.resolve(
      homeServer.start({
        dataDirectoryPath: `${__dirname}/../data`,
        logStreamCallback: (chunk: Buffer) => {
          // eslint-disable-next-line no-console
          console.log(chunk.toString())
        },
        environment: env.getAll(),
      }),
    )
      .then((result) => {
        if (result.isFailed()) {
          // start() already logged the redacted classification. What reaches
          // the console here is the BOUNDED text of the Result: a constant
          // string such as a named precondition or a parser's own message,
          // and a fixed placeholder whenever the text could carry a path,
          // URL or configured value (see boundedBootFailureText).
          const bootRefusal = boundedBootFailureText(result.getError())
          console.error('Could not start server.', { cause: bootRefusal })
          process.exitCode = 1
        }
      })
      .catch((error) => {
        console.error('Could not start server.', safeErrorLogMetadata(error))
        process.exitCode = 1
      })
  } catch (error) {
    console.error('Could not initialize the home server.', safeErrorLogMetadata(error))
    process.exitCode = 1
  }
}
