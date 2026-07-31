import { safeErrorLogMetadata } from '@standardnotes/domain-core'
import { Env } from '../src/Bootstrap/Env'
import { HomeServer } from '../src/Server/HomeServer'

if (process.argv.length === 3 && process.argv[2] === '--srn-release-self-test') {
  process.stdout.write(`srn-native-self-test-v1 ${process.platform} ${process.arch}\n`)
} else {
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
    ).catch((error) => {
      console.error('Could not start server.', safeErrorLogMetadata(error))
    })
  } catch (error) {
    console.error('Could not initialize the home server.', safeErrorLogMetadata(error))
  }
}
