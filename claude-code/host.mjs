// pi-context-engineer's Claude Code host: a small shim of Pi's ExtensionAPI
// that runs this package's extension entry, so offloading, previews, the
// store, the ctx_* tools and /ce are the same code in Claude Code as in Pi.
// daemon.mjs serves these ops to the `ce` Claude Code mod, one daemon per
// session; src/verify-claude-host.ts drives them in the package's tests.
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** The package this host ships in. */
export const PACKAGE_DIR = dirname(HERE)

export const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
})()

/** The section Claude Code's system prompt gives Context Engineer: guide.md, filled in. */
export const guide = () => {
  let text
  try {
    text = readFileSync(join(HERE, 'guide.md'), 'utf8')
  } catch {
    return ''
  }

  return text
    .replaceAll('{{version}}', VERSION)
    .replaceAll('{{skill}}', join(PACKAGE_DIR, 'skills', 'context-engineer', 'SKILL.md'))
    .trim()
}

// Unknown members answer a no-op, so an extension that calls a Pi API this
// shim does not model degrades instead of failing to load.
const lenient = target =>
  new Proxy(target, {
    get: (object, key) => (key in object ? object[key] : typeof key === 'string' && key !== 'then' ? () => undefined : undefined),
  })

const textOf = content =>
  (Array.isArray(content) ? content : [])
    .filter(block => block?.type === 'text')
    .map(block => block.text ?? '')
    .join('\n')

/**
 * One Claude Code session's host. `load` runs the extension's factory against
 * the shim and starts its session; `ops` answer the mod's requests; `drain`
 * takes what the extension said outside a tool result since it last ran.
 */
export const createHost = ({ cwd, sessionId, log = () => undefined }) => {
  const handlers = new Map()
  const tools = new Map()
  const commands = new Map()
  const bus = new Map()
  // What the extension said outside a tool result: notices and messages.
  let outbox = []

  const pi = lenient({
    on(name, handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler])
    },
    registerTool(tool) {
      tools.set(tool.name, tool)
    },
    registerCommand(name, spec) {
      commands.set(name, spec)
    },
    // Every result this host hands over is a fabric_exec result, and its
    // handles are read back as extensions.ctx_read inside a program.
    getActiveTools: () => [...tools.keys(), 'fabric_exec'],
    sendMessage(message, options) {
      outbox.push({
        kind: 'message',
        content: String(message?.content ?? ''),
        display: message?.display !== false,
        deliverAs: options?.deliverAs ?? 'nextTurn',
      })
    },
    events: {
      emit(name, data) {
        for (const listener of bus.get(name) ?? []) listener(data)
      },
      on(name, listener) {
        bus.set(name, [...(bus.get(name) ?? []), listener])
        return () => bus.set(name, (bus.get(name) ?? []).filter(one => one !== listener))
      },
    },
    exec: (command, args = [], options = {}) =>
      new Promise(resolve => {
        execFile(command, args, { timeout: options.timeout, cwd: options.cwd ?? cwd }, (error, stdout, stderr) =>
          resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout: String(stdout), stderr: String(stderr) }),
        )
      }),
  })

  const context = (notices = outbox) =>
    lenient({
      cwd,
      hasUI: true,
      ui: lenient({
        notify: (text, level = 'info') => notices.push({ kind: 'notify', text: String(text), level }),
      }),
      isProjectTrusted: () => true,
      sessionManager: lenient({ getSessionId: () => sessionId, getBranch: () => [] }),
      reload: async () => {
        outbox.push({ kind: 'reload' })
      },
    })

  // Runs an event's handlers in registration order. A `tool_result` handler
  // that answers `{ content }` rewrites what the next one sees, as Pi's
  // middleware does.
  const emit = async (name, event) => {
    let current = event
    let answer
    for (const handler of handlers.get(name) ?? []) {
      try {
        const result = await handler(current, context())
        if (result === undefined || result === null) continue
        answer = result
        if (name === 'tool_result' && Array.isArray(result.content)) {
          current = { ...current, content: result.content, details: result.details ?? current.details }
        }
      } catch (error) {
        log(`${name} handler failed:`, error?.message ?? error)
      }
    }
    return answer
  }

  const ops = {
    hello: async () => ({
      version: VERSION,
      package: PACKAGE_DIR,
      tools: [...tools.values()].map(tool => ({
        name: tool.name,
        description: tool.description ?? '',
        // TypeBox schemas are JSON schema objects.
        parameters: JSON.parse(JSON.stringify(tool.parameters ?? { type: 'object' })),
      })),
      commands: [...commands.keys()],
      guide: guide(),
    }),
    // A ctx_* call. One a program made carries Fabric's nested id prefix,
    // which CE reads as program data: the bare selection, up to its nested
    // budget.
    tool: async ({ name, params, id, isNested }) => {
      const tool = tools.get(name)
      if (!tool) throw new Error(`pi-context-engineer ${VERSION} registers no tool ${name}`)
      const callId = `${isNested ? 'fabric_' : ''}${id ?? `cc-${Date.now()}`}`
      const result = await tool.execute(callId, params ?? {}, undefined, undefined, context())
      return { text: textOf(result?.content), details: result?.details ?? {} }
    },
    // A program's whole result, as Pi's tool events for one fabric_exec call;
    // `input` is the call's, its code and any maxOutputTokens it set. `text`
    // is what the model reads in its place, or null to keep it as it is.
    result: async ({ toolCallId, input, isError, text }) => {
      const event = { toolName: 'fabric_exec', toolCallId, input: input ?? {} }
      await emit('tool_call', event)
      const answer = await emit('tool_result', { ...event, isError: isError === true, content: [{ type: 'text', text: text ?? '' }], details: {} })
      await emit('tool_execution_end', { ...event, isError: isError === true })
      return { text: Array.isArray(answer?.content) ? textOf(answer.content) : null, details: answer?.details ?? null }
    },
    // One model request, which Pi starts with turn_start.
    turn: async ({ index } = {}) => {
      await emit('turn_start', { type: 'turn_start', turnIndex: Number(index) || 0, timestamp: Date.now() })
      return {}
    },
    command: async ({ name, args }) => {
      const command = commands.get(name)
      if (!command) throw new Error(`pi-context-engineer ${VERSION} registers no command ${name}`)
      const notices = []
      await command.handler(args ?? '', context(notices))
      return { text: notices.map(notice => notice.text).join('\n') }
    },
    shutdown: async () => {
      await emit('session_shutdown', {})
      return {}
    },
  }

  return {
    ops,
    load: async extension => {
      await extension(pi)
      await emit('session_start', { reason: 'startup' })
      return [...tools.keys()]
    },
    drain: () => {
      const said = outbox
      outbox = []
      return said
    },
  }
}
