import { planObjectSchema, type PlanValue } from '../plan-value.ts'
import type { HarnessId } from './types.ts'

// One hook event under the three harnesses' own names. A group is one event; a source event with no
// group has no counterpart, which is a gap, never a copied name. Codex's 14 events and Pi's 10 here
// are the overlap ticket 12 settled; OpenCode holds three of them as plugin hooks.
interface HookEvent {
  codex?: string
  pi?: string
  opencode?: { name: string; hook: 'tool' | 'session' }
}

const HOOK_EVENTS: readonly HookEvent[] = [
  { codex: 'SessionStart', pi: 'session_start' },
  { codex: 'SessionEnd', pi: 'session_shutdown' },
  { codex: 'UserPromptSubmit', pi: 'input' },
  { codex: 'PreToolUse', pi: 'tool_call', opencode: { name: 'execute.before', hook: 'tool' } },
  { codex: 'PostToolUse', pi: 'tool_result', opencode: { name: 'execute.after', hook: 'tool' } },
  { codex: 'PreCompact', pi: 'session_before_compact' },
  { codex: 'PostCompact', pi: 'session_compact' },
  {
    codex: 'PreModelRequest',
    pi: 'before_provider_request',
    opencode: { name: 'context', hook: 'session' },
  },
  { codex: 'PostModelRequest', pi: 'after_provider_response' },
  { codex: 'Stop', pi: 'turn_end' },
]

function groupOf(event: string): HookEvent | undefined {
  return HOOK_EVENTS.find(
    (group) => group.codex === event || group.pi === event || group.opencode?.name === event,
  )
}

// A handler as the target will hold it, with its timeout already in milliseconds: Codex reads
// seconds and both other targets read milliseconds, so the conversion happens once, here.
export interface HookCarried {
  command: string
  timeoutMs?: number
  statusMessage?: string
  print?: boolean
}

// A handler field a target can hold. One it cannot is a gap on the plan, never a silent drop.
export type HookHandlerField = 'timeout' | 'statusMessage' | 'print'

interface HookSurfaceCommon {
  // The target's own name for a source event, or undefined when it has no counterpart.
  eventName(sourceEvent: string): string | undefined
  holds: readonly HookHandlerField[]
  // The unit this target reads a timeout in. The vocabulary holds seconds, so only a target reading
  // milliseconds is a mapped field rather than a carried one.
  timeoutUnit: 'seconds' | 'milliseconds'
}

// A pointer target keeps hooks as declarative config in its own hooks file.
export interface HookEntrySurface extends HookSurfaceCommon {
  kind: 'pointer'
  // What the plan appends to `hooks.<event>`: the target's own entry shape, one entry per handler
  // where the target holds one command per entry.
  entries(handlers: readonly HookCarried[], matcher: string | undefined): PlanValue[]
}

// A generated target has no hook config at all, so the mirror writes plugin code instead.
export interface HookGeneratedSurface extends HookSurfaceCommon {
  kind: 'generated'
  // The module a mirror writes, under the name it lands with inside the tier's plugin directory.
  plugin(
    source: { harness: string; event: string },
    targetEvent: string,
    handlers: readonly HookCarried[],
  ): { file: string; text: string }
}

export type HookWriteSurface = HookEntrySurface | HookGeneratedSurface

const codex: HookEntrySurface = {
  kind: 'pointer',
  holds: ['timeout', 'statusMessage'],
  timeoutUnit: 'seconds',
  eventName: (sourceEvent) => groupOf(sourceEvent)?.codex,
  entries(handlers, matcher) {
    const hooks = handlers.map((handler) => {
      const entry = planObjectSchema.parse({ type: 'command', command: handler.command })
      if (handler.timeoutMs !== undefined) entry.timeout = handler.timeoutMs / 1000
      if (handler.statusMessage !== undefined) entry.statusMessage = handler.statusMessage
      return entry
    })
    // A wildcard matcher is carried as it was written; the planner never widens one.
    const group = planObjectSchema.parse({ hooks })
    if (matcher !== undefined) group.matcher = matcher
    return [group]
  },
}

const pi: HookEntrySurface = {
  kind: 'pointer',
  holds: ['timeout', 'print'],
  timeoutUnit: 'milliseconds',
  eventName: (sourceEvent) => groupOf(sourceEvent)?.pi,
  entries(handlers) {
    return handlers.map((handler) => {
      const entry = planObjectSchema.parse({ command: handler.command })
      if (handler.timeoutMs !== undefined) entry.timeout = handler.timeoutMs
      if (handler.print !== undefined) entry.print = handler.print
      return entry
    })
  },
}

const opencode: HookGeneratedSurface = {
  kind: 'generated',
  holds: ['timeout'],
  timeoutUnit: 'milliseconds',
  eventName: (sourceEvent) => groupOf(sourceEvent)?.opencode?.name,
  plugin(source, targetEvent, handlers) {
    const hook = groupOf(source.event)?.opencode?.hook ?? 'tool'
    const id = `acm-${kebab(source.harness)}-${kebab(source.event)}`
    const commands = handlers
      .map((handler) => {
        const entry = { command: handler.command, timeout: handler.timeoutMs }
        return `    ${JSON.stringify(entry)},`
      })
      .join('\n')
    const text = `import { execSync } from 'node:child_process'
import { Plugin } from '@opencode/plugin'

// Generated by acm from the ${source.harness} ${source.event} hook. This module is executable code:
// read the command it runs before OpenCode is restarted.
const commands = [
${commands}
]

export default Plugin.define({
  id: ${JSON.stringify(id)},
  async setup(ctx) {
    for (const { command, timeout } of commands) {
      await ${registration(hook, targetEvent)}
    }
  },
})
`
    return { file: `${id}.ts`, text }
  },
}

// The callback OpenCode documents for each hook kind: a tool hook is handed the call it is about to
// allow or has just run, and the context hook owns the parts of the model request, so this is where a
// command's output becomes the context part a Codex `PreModelRequest` handler was written to supply.
function registration(hook: 'tool' | 'session', targetEvent: string): string {
  if (hook === 'session') {
    return `ctx.session.hook(${JSON.stringify(targetEvent)}, (event) => {
        event.system.push({ type: 'text', text: execSync(command, { timeout, encoding: 'utf8' }) })
      })`
  }
  return `ctx.tool.hook(${JSON.stringify(targetEvent)}, () => {
        execSync(command, { timeout })
      })`
}

export const HOOK_WRITE_SURFACES = { codex, pi, opencode } satisfies Record<
  HarnessId,
  HookWriteSurface
>

// A hook event name is a file name here, so it is folded to one: `PreToolUse` and `tool_call` both
// name a module the same way a harness would find it.
function kebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase()
}
