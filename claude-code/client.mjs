// The `ce` Claude Code mod's client: one request to the session's daemon. It
// starts the daemon when none runs, and starts it again when this package or
// its source differs from what the daemon loaded, so an edit to a checkout
// applies from the next call. The request is read from stdin and the response
// printed as one JSON line, with `restarted: true` when a changed source was
// loaded.
//   client.mjs <dir> <id> <cwd> <sessionId> <timeoutMs>
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { stampOf } from './stamp.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = dirname(here)
const [dir, id, cwd, sessionId, timeoutMs] = process.argv.slice(2)
const SANDBOX = '/usr/bin/sandbox-exec'
const sleep = ms => new Promise(done => setTimeout(done, ms))
const finish = response => {
  process.stdout.write(JSON.stringify(response))
  process.exit(0)
}

const pidOf = () => Number(readFileSync(join(dir, 'pid'), 'utf8'))
const isAlive = () => {
  try {
    process.kill(pidOf(), 0)
    return true
  } catch {
    return false
  }
}
const loaded = () => {
  try {
    return readFileSync(join(dir, 'loaded'), 'utf8')
  } catch {
    return ''
  }
}
const wanted = `${pkg}\n${stampOf(pkg)}`
const isCurrent = () => isAlive() && loaded() === wanted && existsSync(join(dir, 'ready'))

const stop = async () => {
  try {
    process.kill(pidOf(), 'SIGTERM')
  } catch {
    return
  }
  for (let waited = 0; isAlive(); waited += 25) {
    if (waited > 3000) {
      try {
        process.kill(pidOf(), 'SIGKILL')
      } catch {
        // gone meanwhile
      }
    }
    await sleep(25)
  }
}

const awaitCurrent = async () => {
  for (let waited = 0; !isCurrent(); waited += 25) {
    if (waited > 30000) finish({ ok: false, error: `the context-engineer daemon did not start; see ${join(dir, 'daemon.log')}` })
    await sleep(25)
  }
}

// One caller starts the daemon; another that finds it starting waits for it.
const start = async () => {
  mkdirSync(dir, { recursive: true })
  const lock = join(dir, 'starting')
  try {
    mkdirSync(lock)
  } catch {
    if (Date.now() - statSync(lock).mtimeMs < 30000) return awaitCurrent()
    rmSync(lock, { recursive: true, force: true })
    mkdirSync(lock)
  }
  try {
    if (isAlive()) await stop()
    mkdirSync(join(dir, 'req'), { recursive: true })
    mkdirSync(join(dir, 'res'), { recursive: true })
    rmSync(join(dir, 'ready'), { force: true })
    const out = openSync(join(dir, 'daemon.log'), 'a')
    const daemon = [process.execPath, join(here, 'daemon.mjs'), dir, cwd, sessionId, String(process.ppid)]
    // The store is local files: the engine needs no network.
    const argv = existsSync(SANDBOX) ? [SANDBOX, '-p', '(version 1)(allow default)(deny network*)', ...daemon] : daemon
    spawn(argv[0], argv.slice(1), { cwd, detached: true, stdio: ['ignore', out, out] }).unref()
    await awaitCurrent()
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

let request = ''
for await (const chunk of process.stdin) request += chunk
if (JSON.parse(request).op === 'shutdown') {
  if (!isAlive()) finish({ ok: true, value: {}, outbox: [] })
} else if (!isCurrent()) {
  const restarted = isAlive() && loaded() !== '' && loaded() !== wanted
  await start()
  if (restarted) writeFileSync(join(dir, 'restarted'), '1')
}

writeFileSync(join(dir, 'req', `${id}.tmp`), request)
renameSync(join(dir, 'req', `${id}.tmp`), join(dir, 'req', `${id}.json`))
const response = join(dir, 'res', `${id}.json`)
const deadline = Date.now() + Number(timeoutMs || 120000)
for (let wait = 4; !existsSync(response); wait = Math.min(wait * 2, 50)) {
  if (Date.now() > deadline) finish({ ok: false, error: 'context-engineer timed out' })
  if (wait === 50 && !isAlive()) finish({ ok: false, error: `the context-engineer daemon exited; see ${join(dir, 'daemon.log')}` })
  await sleep(wait)
}
const reply = JSON.parse(readFileSync(response, 'utf8'))
rmSync(response, { force: true })
// The first reply after a changed source says so, whichever call restarted it.
if (existsSync(join(dir, 'restarted'))) {
  rmSync(join(dir, 'restarted'), { force: true })
  reply.restarted = true
}
process.stdout.write(JSON.stringify(reply))
process.exit(0)
