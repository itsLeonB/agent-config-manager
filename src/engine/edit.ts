import { parse as parseToml } from 'smol-toml'
import { z } from 'zod'
import { planObjectSchema, planValueSchema, type PlanValue } from './plan.ts'

// A native config file is edited in place, not re-serialised: a plan writes addresses, and every
// byte it did not address — comments, key order, sibling entries — is somebody else's.
export type EditResult = { kind: 'ok'; text: string } | { kind: 'failed'; reason: string }

export type PlanFormat = 'json' | 'toml'

export function formatOf(file: string): PlanFormat {
  return file.endsWith('.toml') ? 'toml' : 'json'
}

// One pointer write, applied to the text as it stands now: each write re-reads the document the
// previous one produced, because an inserted parent moves every address below it.
export function writePointer(
  text: string,
  format: PlanFormat,
  segments: string[],
  value: PlanValue,
): EditResult {
  try {
    return format === 'toml' ? writeToml(text, segments, value) : writeJson(text, segments, value)
  } catch (error) {
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
}

// Whether a document the editor produced is still a document the harness can read. Checked before
// anything reaches disk, so a bad insertion fails the write instead of corrupting the file.
export function parses(text: string, format: PlanFormat): boolean {
  try {
    if (format === 'toml') {
      parseToml(text)
      return true
    }
    parseJsonDocument(text)
    return true
  } catch {
    return false
  }
}

interface JsonObject {
  kind: 'object'
  start: number
  end: number
  // Where a new member goes: right after the last member's value, or after `{` when there is none.
  insertAt: number
  members: Map<string, { keyStart: number; value: JsonNode }>
}

type JsonNode =
  | JsonObject
  | { kind: 'array'; start: number; end: number }
  | { kind: 'scalar'; start: number; end: number }

// A JSONC-aware scanner that records spans. Only two questions are ever asked of it — where a value
// sits, and where a missing member would go — so it keeps no tree beyond the members of an object.
function parseJsonDocument(text: string): JsonNode {
  let at = 0

  function skip(): void {
    for (;;) {
      const char = text[at]
      if (char === ' ' || char === '\n' || char === '\r' || char === '\t') {
        at += 1
        continue
      }
      if (char === '/' && text[at + 1] === '/') {
        while (at < text.length && text[at] !== '\n') at += 1
        continue
      }
      if (char === '/' && text[at + 1] === '*') {
        const end = text.indexOf('*/', at + 2)
        if (end === -1) throw new Error('an unterminated comment would swallow the rest of the file')
        at = end + 2
        continue
      }
      return
    }
  }

  function parseString(): string {
    const start = at
    at += 1
    while (at < text.length && text[at] !== '"') at += text[at] === '\\' ? 2 : 1
    if (at >= text.length) throw new Error('an unterminated string')
    at += 1
    return JSON.parse(text.slice(start, at))
  }

  function parseValue(): JsonNode {
    skip()
    const char = text[at]
    if (char === '{') return parseObject()
    if (char === '[') return parseArray()
    if (char === '"') {
      const start = at
      parseString()
      return { kind: 'scalar', start, end: at }
    }
    const start = at
    while (at < text.length && !/[\s,\]}/]/.test(text[at] ?? '')) at += 1
    if (at === start) throw new Error('a value was expected')
    return { kind: 'scalar', start, end: at }
  }

  function parseArray(): JsonNode {
    const start = at
    at += 1
    skip()
    if (text[at] === ']') {
      at += 1
      return { kind: 'array', start, end: at }
    }
    for (;;) {
      parseValue()
      skip()
      if (text[at] === ',') {
        at += 1
        continue
      }
      if (text[at] === ']') {
        at += 1
        return { kind: 'array', start, end: at }
      }
      throw new Error('a comma or a closing bracket was expected')
    }
  }

  function parseObject(): JsonObject {
    const start = at
    at += 1
    const members = new Map<string, { keyStart: number; value: JsonNode }>()
    skip()
    if (text[at] === '}') {
      at += 1
      return { kind: 'object', start, end: at, insertAt: start + 1, members }
    }
    let insertAt = start + 1
    for (;;) {
      skip()
      if (text[at] !== '"') throw new Error('a quoted key was expected')
      const keyStart = at
      const key = parseString()
      skip()
      if (text[at] !== ':') throw new Error('a colon was expected after a key')
      at += 1
      const value = parseValue()
      members.set(key, { keyStart, value })
      insertAt = value.end
      skip()
      if (text[at] === ',') {
        at += 1
        continue
      }
      if (text[at] === '}') {
        at += 1
        return { kind: 'object', start, end: at, insertAt, members }
      }
      throw new Error('a comma or a closing brace was expected')
    }
  }

  const document = parseValue()
  skip()
  return document
}

function writeJson(text: string, segments: string[], value: PlanValue): EditResult {
  const root = parseJsonDocument(text)
  if (segments.length === 0) throw new Error('a write needs a pointer below the document root')
  let node: JsonNode = root
  for (const [index, segment] of segments.entries()) {
    const address = segments.slice(0, index).join('.')
    if (node.kind !== 'object') {
      throw new Error(`${address === '' ? 'the document root' : address} is not an object, so ${segments.join('.')} cannot be written into it`)
    }
    const member = node.members.get(segment)
    if (member !== undefined) {
      node = member.value
      continue
    }
    // The address does not exist yet: everything from here down is created in one insertion, so a
    // new entry arrives whole rather than leaving half-built parents behind. An object that sits on
    // one line stays on one line — reformatting it would be a change the plan never asked for.
    const indent = childIndent(text, node)
    const inline = !text.slice(node.start, node.end).includes('\n')
    const rendered = pretty(nest(segments.slice(index + 1), value), indent, inline)
    const inserted = `${JSON.stringify(segment)}: ${rendered}`
    const insert =
      node.members.size === 0
        ? inline
          ? inserted
          : `\n${indent}${inserted}`
        : inline
          ? `, ${inserted}`
          : `,\n${indent}${inserted}`
    return { kind: 'ok', text: text.slice(0, node.insertAt) + insert + text.slice(node.insertAt) }
  }
  if (node.kind !== 'scalar') throw new Error(`${segments.join('.')} holds a ${node.kind}, not a value this engine writes`)
  return { kind: 'ok', text: text.slice(0, node.start) + JSON.stringify(value) + text.slice(node.end) }
}

function nest(segments: string[], value: PlanValue): PlanValue {
  return segments.reduceRight<PlanValue>((inner, segment) => ({ [segment]: inner }), value)
}

// The indentation of the line a position sits on, so an inserted member lines up with its siblings.
function indentAt(text: string, position: number): string {
  const lineStart = text.lastIndexOf('\n', position - 1) + 1
  return /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? ''
}

function childIndent(text: string, node: JsonObject): string {
  const last = [...node.members.values()].at(-1)
  return last === undefined ? `${indentAt(text, node.start)}  ` : indentAt(text, last.keyStart)
}

function pretty(value: PlanValue, indent: string, inline: boolean): string {
  if (inline) return JSON.stringify(value)
  return JSON.stringify(value, null, 2).split('\n').join(`\n${indent}`)
}

const TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/

function tomlKey(name: string): string {
  return TOML_BARE_KEY.test(name) ? name : JSON.stringify(name)
}

function tomlPath(segments: string[]): string {
  return segments.map(tomlKey).join('.')
}

interface TomlTable {
  path: string[]
  header: number
  // Line indices the table owns, exclusive of the header and of the next table's header line.
  bodyStart: number
  bodyEnd: number
}

function tomlTables(lines: string[]): TomlTable[] {
  const tables: TomlTable[] = []
  let open: TomlTable | undefined
  for (const [index, line] of lines.entries()) {
    const header = /^\s*\[([^[\]]+)\]/.exec(line)
    if (header === null) continue
    if (open !== undefined) open.bodyEnd = index - 1
    open = { path: parseTomlPath(header[1] ?? ''), header: index, bodyStart: index + 1, bodyEnd: lines.length - 1 }
    tables.push(open)
  }
  return tables
}

// The segments a table header names, unquoted: `mcp_servers."my.server"` is two of them.
function parseTomlPath(path: string): string[] {
  const segments: string[] = []
  const token = /(?:"((?:[^"\\]|\\.)*)"|([A-Za-z0-9_-]+))/g
  for (const match of path.matchAll(token)) {
    segments.push(match[1] === undefined ? (match[2] ?? '') : JSON.parse(`"${match[1]}"`))
  }
  return segments
}

function writeToml(text: string, segments: string[], value: PlanValue): EditResult {
  if (segments.length === 0) throw new Error('a write needs a pointer below the document root')
  const lines = text.split('\n')
  const tables = tomlTables(lines)
  const parent = segments.slice(0, -1)
  const key = segments.at(-1) ?? ''
  const rendered = tomlValue(value)
  const table = tables.find((candidate) => samePath(candidate.path, parent))
  if (table === undefined) {
    const shadowed = tables.find((candidate) => samePath(candidate.path, segments))
    if (shadowed !== undefined) {
      throw new Error(`${segments.join('.')} is a table of its own, not a value this engine writes`)
    }
    // A parent defined inline (`env = { A = "1" }`) cannot be extended line by line, and appending a
    // second `[mcp_servers.x.env]` table would be a duplicate key the harness rejects.
    if (definesPath(text, parent)) {
      throw new Error(`${parent.join('.')} is an inline table, so ${segments.join('.')} needs a hand edit`)
    }
    const header = `[${tomlPath(parent)}]`
    // A blank line before an appended table, so the new section is visibly its own.
    const separator = text === '' ? '' : text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n'
    return { kind: 'ok', text: `${text}${separator}${header}\n${tomlKey(key)} = ${rendered}\n` }
  }
  const body = lines.slice(table.bodyStart, table.bodyEnd + 1)
  const found = body.findIndex((line) => tomlLineKey(line) === key)
  const keyLine = `${tomlKey(key)} = ${rendered}`
  if (found !== -1) {
    const index = table.bodyStart + found
    const line = lines[index] ?? ''
    const indent = /^[ \t]*/.exec(line)?.[0] ?? ''
    // A comment that sits on the addressed line belongs to the file, not to the value being replaced.
    const comment = tomlTrailingComment(line)
    lines[index] = `${indent}${keyLine}${comment === null ? '' : ` ${comment}`}`
    return { kind: 'ok', text: lines.join('\n') }
  }
  let assigned = -1
  for (const [index, line] of body.entries()) {
    if (line.trim() !== '' && !line.trim().startsWith('#')) assigned = table.bodyStart + index
  }
  const indent = assigned === -1 ? '' : (/^[ \t]*/.exec(lines[assigned] ?? '')?.[0] ?? '')
  // Inserted after the table's last assignment, so a comment block above the next table stays with it.
  lines.splice(assigned === -1 ? table.header + 1 : assigned + 1, 0, `${indent}${keyLine}`)
  return { kind: 'ok', text: lines.join('\n') }
}

function samePath(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index])
}

// The bare key a table-body line assigns, unquoted; null for a line that assigns nothing.
function tomlLineKey(line: string): string | null {
  const match = /^\s*(?:"((?:[^"\\]|\\.)*)"|([A-Za-z0-9_-]+))\s*=/.exec(line)
  if (match === null) return null
  return match[1] === undefined ? (match[2] ?? null) : JSON.parse(`"${match[1]}"`)
}

// The `#` comment after a value, if it is outside a string: `command = "a # b"` has none.
function tomlTrailingComment(line: string): string | null {
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quoted && char === '\\') {
      index += 1
      continue
    }
    if (char === '"') quoted = !quoted
    if (char === '#' && !quoted) return line.slice(index).trimEnd()
  }
  return null
}

// Whether the document already defines this path, which makes an appended table header a duplicate
// key: `env = { A = "1" }` is a table TOML will not let a `[mcp_servers.x.env]` header repeat.
function definesPath(text: string, segments: string[]): boolean {
  const document = planObjectSchema.safeParse(parseToml(text))
  if (!document.success) return false
  let node: PlanValue | undefined = document.data
  for (const segment of segments) {
    const object = planObjectSchema.safeParse(node)
    if (!object.success) return false
    node = object.data[segment]
  }
  return node !== undefined
}

function tomlValue(value: PlanValue): string {
  const text = z.string().safeParse(value)
  if (text.success) return JSON.stringify(text.data)
  const scalar = z.union([z.number(), z.boolean()]).safeParse(value)
  if (scalar.success) return String(scalar.data)
  const list = z.array(planValueSchema).safeParse(value)
  if (list.success) return `[${list.data.map(tomlValue).join(', ')}]`
  const map = planObjectSchema.safeParse(value)
  if (!map.success) throw new Error('TOML has no null, so a null cannot be written')
  const entries = Object.entries(map.data).map(([name, entry]) => `${tomlKey(name)} = ${tomlValue(entry)}`)
  return `{ ${entries.join(', ')} }`
}
