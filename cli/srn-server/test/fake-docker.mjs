// Body of the fake `docker` used by the srn-server tests.
//
// The fake is a link to the node binary named `docker`, preloaded with this
// module via NODE_OPTIONS. A shell script cannot be used: Windows refuses to
// spawn `.cmd`/`.bat` without a shell, and libuv skips them during PATH lookup,
// so a real docker further along PATH would silently win — the tests would then
// be talking to a real daemon instead of a stub.
//
// NODE_OPTIONS is inherited by the CLI under test too, hence the guard: only the
// process actually launched as `docker` behaves as docker; everything else is a
// no-op preload.
import path from 'node:path'

// All three are checked because they disagree depending on how the link was
// made: process.execPath comes from /proc/self/exe on Linux and resolves a
// SYMLINK back to the real node binary, while process.argv0 keeps the name the
// process was actually launched under.
const isDocker = [process.argv0, process.argv[0], process.execPath]
  .filter(Boolean)
  .some((n) => path.basename(n, path.extname(n)).toLowerCase() === 'docker')

if (isDocker) {
  // process.argv[1] onwards are docker's own arguments. Node treats argv[1] as
  // the main script and resolves it against the cwd, so the first argument comes
  // back as an absolute path; strip that back down. Later arguments are left
  // exactly as passed. srn-server always invokes docker with the literal
  // subcommand `compose` first, so this never loses information.
  const args = process.argv.slice(1)
  if (args.length > 0) {
    args[0] = path.basename(args[0])
  }
  process.stdout.write(`FAKE-DOCKER ${args.join(' ')}\n`)
  if (process.env.FAKE_DOCKER_STDERR) {
    process.stderr.write(`${process.env.FAKE_DOCKER_STDERR}\n`)
  }
  process.exit(Number(process.env.FAKE_DOCKER_EXIT ?? 0))
}
