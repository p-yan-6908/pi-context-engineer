// The daemon behind the `ce` Claude Code mod: one per session, serving
// host.mjs's ops over a file queue. client.mjs starts it, and starts it again
// when the package's source changes, so an edit to a checkout applies from
// the next call.
//   request   <dir>/req/<id>.json   {op, ...}
//   response  <dir>/res/<id>.json   {ok, value | error, outbox}
//   daemon.mjs <dir> <cwd> <sessionId> <ownerPid>
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, watch, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { PACKAGE_DIR, VERSION, createHost } from './host.mjs'
import { stampOf } from './stamp.mjs'

const [dir, cwd, sessionId, ownerPid] = process.argv.slice(2)
const reqDir = join(dir, 'req')
const resDir = join(dir, 'res')
mkdirSync(reqDir, { recursive: true })
mkdirSync(resDir, { recursive: true })
writeFileSync(join(dir, 'pid'), String(process.pid))
// Taken before the import, so an edit made while it loads still counts as new.
const stamp = stampOf(PACKAGE_DIR)

const log = (...parts) => console.error(new Date().toISOString(), ...parts)
const host = createHost({ cwd, sessionId, log })
const ops = {
  ...host.ops,
  hello: async () => ({ ...(await host.ops.hello()), stamp, pid: process.pid }),
  shutdown: async () => {
    await host.ops.shutdown()
    setTimeout(() => process.exit(0), 50)
    return {}
  },
}

// Host events keep their order; tool calls may overlap, as Pi runs them.
let chain = Promise.resolve()
const seen = new Set()
const answer = async file => {
  const id = file.slice(0, -'.json'.length)
  let response
  try {
    const request = JSON.parse(readFileSync(join(reqDir, file), 'utf8'))
    rmSync(join(reqDir, file), { force: true })
    const op = ops[request.op]
    if (!op) throw new Error(`unknown op ${request.op}`)
    const run = () => op(request)
    const value = await (request.op === 'tool' ? run() : (chain = chain.catch(() => undefined).then(run)))
    response = { ok: true, value }
  } catch (error) {
    response = { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  response.outbox = host.drain()
  writeFileSync(join(resDir, `${id}.tmp`), JSON.stringify(response))
  renameSync(join(resDir, `${id}.tmp`), join(resDir, `${id}.json`))
}
const scan = () => {
  for (const file of readdirSync(reqDir)) {
    if (!file.endsWith('.json') || seen.has(file)) continue
    seen.add(file)
    void answer(file).finally(() => seen.delete(file))
  }
}

try {
  const extension = await import(pathToFileURL(join(PACKAGE_DIR, 'src', 'index.ts')).href)
  const tools = await host.load(extension.default)
  log(`pi-context-engineer ${VERSION} loaded from ${PACKAGE_DIR} (${stamp}): ${tools.join(', ')}`)
} catch (error) {
  log('pi-context-engineer failed to load:', error?.stack ?? error)
  const message = `pi-context-engineer failed to load from ${PACKAGE_DIR}: ${error?.message ?? error}`
  for (const name of Object.keys(ops)) if (name !== 'shutdown') ops[name] = async () => { throw new Error(message) }
}

try {
  watch(reqDir, scan)
} catch {
  // the interval below still serves
}
setInterval(scan, 200)
scan()
// What this daemon runs, for the client to compare with the source on disk.
writeFileSync(join(dir, 'loaded'), `${PACKAGE_DIR}\n${stamp}`)
writeFileSync(join(dir, 'ready'), '1')

// The session that owns this daemon is gone: so is the daemon.
setInterval(() => {
  try {
    process.kill(Number(ownerPid), 0)
  } catch {
    process.exit(0)
  }
}, 5000)
