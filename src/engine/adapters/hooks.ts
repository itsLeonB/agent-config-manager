import { existsSync, readFileSync } from 'node:fs'
import { z } from 'zod'
import { digestOfPath } from '../digest.ts'
import { classify, withheldMarker } from '../secret.ts'
import { stripJsonc } from './opencode/read.ts'
import { declaredPaths, type DiscoveredInstallation, type Tier, type TierRead } from './types.ts'

// A hook's canonical vocabulary is what one hook is made of whatever the harness calls it: the event
// it fires on, the matcher that narrows it, and the handlers it runs. The event is renamed per
// target, never copied (see `hook-write.ts`); everything else travels as it is, or becomes a gap.
export const HOOK_FIELDS = ['event', 'matcher', 'handlers'] as const

const handlerSchema = z.object({
  // Codex spells the handler kind out (`command` or `mcp_tool`); Pi's bridge only has commands, so
  // its reader supplies the type instead of inventing a field.
  type: z.string().optional(),
  command: z.string().optional(),
  // Normalised to seconds by both readers, because Codex reads seconds and Pi's bridge milliseconds.
  // One plan then maps one unit instead of guessing which harness wrote the file.
  timeout: z.number().optional(),
  statusMessage: z.string().optional(),
  print: z.boolean().optional(),
})
export type HookHandler = z.infer<typeof handlerSchema>

export const hookFactsSchema = z.object({
  event: z.string(),
  matcher: z.string().optional(),
  handlers: z.array(handlerSchema),
})
export type HookFacts = z.infer<typeof hookFactsSchema>

// A command is text like any other, and a literal token inside one would otherwise sit in the store
// for `acm inspect` to print. Each is classified here, before it can reach known fields, exactly as
// an instruction body is; a value that is not clean is persisted as its marker, and the planner then
// reports the marker's verdict instead of writing the command anywhere.
function cleanFacts(facts: HookFacts): HookFacts {
  return {
    ...facts,
    handlers: facts.handlers.map((handler, index) => {
      if (handler.command === undefined) return handler
      const { verdict } = classify(`handlers.${index}.command`, handler.command, [])
      return verdict === 'clean' ? handler : { ...handler, command: withheldMarker(verdict) }
    }),
  }
}

// Which harness's hooks file this is: Codex's three-level `event → matcher group → handlers`, or the
// flatter `hooks.<event>[]` of the Pi bridge, where one entry is one command.
export type HookSource = 'codex' | 'pi'

export function readHookTier(tier: Tier, source: HookSource): TierRead {
  const installations: DiscoveredInstallation[] = []
  for (const file of declaredPaths(tier, 'hooks')) {
    if (!existsSync(file)) continue
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return { health: 'unreadable', detail: `${file} could not be read`, installations: [] }
    }
    const parsed = hookDocument(text, source)
    if (parsed.kind === 'invalid') {
      return { health: 'unreadable', detail: `${file}: ${parsed.detail}`, installations: [] }
    }
    // The whole file is the source of every hook in it, so a file edited after the scan makes each
    // of its plans stale — which is what stops a command the scan never classified from landing.
    const digest = digestOfPath(file) ?? ''
    for (const entry of parsed.entries) {
      installations.push({
        category: 'hooks',
        name: entry.facts.event,
        scope: tier.scopeBucket,
        tierId: tier.id,
        nativeFile: file,
        nativePointer: entry.pointer,
        knownFieldsJson: JSON.stringify(cleanFacts(entry.facts)),
        contentDigest: digest,
      })
    }
  }
  return { health: 'ok', detail: null, installations }
}

interface HookEntry {
  pointer: string
  facts: HookFacts
}

type HookDocument =
  | { kind: 'ok'; entries: HookEntry[] }
  // A hooks file this process cannot describe fails the whole tier closed: reported as empty it
  // would tombstone the installs it hides.
  | { kind: 'invalid'; detail: string }

function hookDocument(text: string, source: HookSource): HookDocument {
  let raw: unknown
  try {
    raw = JSON.parse(stripJsonc(text))
  } catch {
    return { kind: 'invalid', detail: 'not JSON' }
  }
  const document = z
    .object({ hooks: z.record(z.string(), z.array(z.unknown())).optional() })
    .safeParse(raw)
  if (!document.success) {
    return { kind: 'invalid', detail: 'no `hooks` object of event arrays' }
  }
  const entries: HookEntry[] = []
  for (const [event, items] of Object.entries(document.data.hooks ?? {})) {
    for (const [index, item] of items.entries()) {
      // Each item is parsed by the schema of the source that owns the file, at this boundary, so
      // nothing below works on an unparsed value.
      const facts =
        source === 'codex'
          ? codexEntry(event, matcherGroupSchema.safeParse(item))
          : piEntry(event, z.string().safeParse(item), piEntrySchema.safeParse(item))
      if (facts === null) {
        return { kind: 'invalid', detail: `hooks.${event}.${index} is not a ${source} hook entry` }
      }
      entries.push({ pointer: `hooks.${event}.${index}`, facts })
    }
  }
  return { kind: 'ok', entries }
}

const matcherGroupSchema = z.object({
  matcher: z.string().optional(),
  hooks: z.array(handlerSchema),
})

const piEntrySchema = z.object({
  command: z.string(),
  print: z.boolean().optional(),
  timeout: z.number().optional(),
})

function codexEntry(
  event: string,
  group: z.ZodSafeParseResult<z.infer<typeof matcherGroupSchema>>,
): HookFacts | null {
  if (!group.success) return null
  return { event, matcher: group.data.matcher, handlers: group.data.hooks }
}

function piEntry(
  event: string,
  bare: z.ZodSafeParseResult<string>,
  entry: z.ZodSafeParseResult<z.infer<typeof piEntrySchema>>,
): HookFacts | null {
  // A bare string is a command, which the bridge accepts and this vocabulary spells out.
  if (bare.success) return { event, handlers: [{ type: 'command', command: bare.data }] }
  if (!entry.success) return null
  const handler: HookHandler = { type: 'command', command: entry.data.command }
  if (entry.data.print !== undefined) handler.print = entry.data.print
  // Pi's bridge reads milliseconds where Codex reads seconds, and the vocabulary holds seconds.
  if (entry.data.timeout !== undefined) handler.timeout = entry.data.timeout / 1000
  return { event, handlers: [handler] }
}
