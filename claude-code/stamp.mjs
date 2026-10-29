// The fingerprint of a package's source: its package.json and every file
// under src/ and claude-code/, by path, size and modification time. The
// daemon records the stamp it loaded; the client starts it again when the
// stamp moves, so an edit to a checkout, its host included, reaches the next
// call.
import { createHash } from 'node:crypto'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const stampOf = dir => {
  const hash = createHash('sha1')
  const add = (path, name) => {
    try {
      const stat = statSync(path)
      hash.update(`${name}:${stat.size}:${stat.mtimeMs}\n`)
    } catch {
      // gone between the listing and the stat: the next stamp sees it
    }
  }
  const walk = (path, name) => {
    let entries
    try {
      entries = readdirSync(path, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      if (entry.isDirectory()) walk(join(path, entry.name), `${name}/${entry.name}`)
      else if (entry.isFile()) add(join(path, entry.name), `${name}/${entry.name}`)
    }
  }
  add(join(dir, 'package.json'), 'package.json')
  walk(join(dir, 'src'), 'src')
  walk(join(dir, 'claude-code'), 'claude-code')

  return hash.digest('hex').slice(0, 16)
}
