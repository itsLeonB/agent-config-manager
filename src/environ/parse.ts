import { parse, TomlError } from 'smol-toml'
import { z } from 'zod'
import { HARNESSES } from '../engine/adapters/types.ts'
import type { HarnessId } from '../engine/adapters/types.ts'
import type { Check, DeclaredEntry, ParseResult, ProvisionDeclaration, Refusal } from './types.ts'

// The parser is total against the closed environment-file schema: every value in the document is
// either decoded into a Provision or refuses the whole file with the line and column of the part at
// fault. A refusal is a value, not a thrown error, so a loader can drop one file and keep the others.

const SUPPORTED_VERSION = 1
const VERSION_KEY = 'version'
const PROVISION_KEY = 'provision'
const TAGS_KEY = 'tags'
const CHECK_KEY = 'check'
const INSTALL_KEY = 'install'
const FILE_KEY = 'file'
const CONTAINS_KEY = 'contains'
const POINTER_KEY = 'pointer'
const EQUALS_KEY = 'equals'
const ON_PATH_KEY = 'onPath'
// The closed predicate set: the keys a Check may carry besides `file`. Anything else is a typo and
// refuses the file, so a Check ACM does not understand is never silently ignored.
const PREDICATE_KEYS: ReadonlySet<string> = new Set([FILE_KEY, CONTAINS_KEY, POINTER_KEY, EQUALS_KEY, ON_PATH_KEY])

// TOML can hold dates and big integers; this schema describes strings, numbers, booleans, arrays, and
// tables, which is every value an environment file is allowed to write.
const TOML_TABLE = z.record(z.string(), z.json())
type EnvironmentTable = z.infer<typeof TOML_TABLE>
type EnvironmentValue = EnvironmentTable[string]

const HARNESS_ID = z.enum(HARNESSES)

type Decoded<T> = { ok: true; value: T } | { ok: false; refusal: Refusal }

function refused<T>(refusal: Refusal): Decoded<T> {
  return { ok: false, refusal }
}

function harnessId(name: string): HarnessId | null {
  const parsed = HARNESS_ID.safeParse(name)
  return parsed.success ? parsed.data : null
}

function stringValue(value: EnvironmentValue | undefined): string | null {
  const parsed = z.string().safeParse(value)
  return parsed.success ? parsed.data : null
}

function tableValue(value: EnvironmentValue | undefined): EnvironmentTable | null {
  const parsed = TOML_TABLE.safeParse(value)
  return parsed.success ? parsed.data : null
}

function stringList(value: EnvironmentValue | undefined): string[] | null {
  const parsed = z.array(z.string()).safeParse(value)
  return parsed.success ? parsed.data : null
}

function has(table: EnvironmentTable, key: string): boolean {
  return Object.hasOwn(table, key)
}

// Where a declaration sits in the text. smol-toml answers values without positions, so the positions
// come from a scan of the keys and table headers; the values themselves still come from the parsed
// document. Anything this scan cannot spell — a quoted key, say — falls back to the file's start.
interface SourceIndex {
  // A declaration is spelled either as a key in its block or as a table header naming it, and the
  // walk asks for the address it already knows rather than guessing which.
  declaration(block: readonly string[], name: string): Refusal | null
  header(block: readonly string[]): Refusal | null
}

const START: Refusal = { line: 1, column: 1, reason: '' }

// An address the scan cannot spell still reports the fault, at the top of the file.
function place(at: Refusal | null, reason: string): Refusal {
  return { line: at?.line ?? START.line, column: at?.column ?? START.column, reason }
}

function unquote(segment: string): string {
  const trimmed = segment.trim()
  const quoted = /^"(.*)"$/.exec(trimmed) ?? /^'(.*)'$/.exec(trimmed)
  return quoted === null ? trimmed : quoted[1]
}

function indexSource(text: string): SourceIndex {
  const headers = new Map<string, Refusal>()
  const keys = new Map<string, Refusal>()
  let block: string[] = []
  for (const [lineNumber, line] of text.split('\n').entries()) {
    const header = /^[ \t]*\[([^[\]]+)\]/.exec(line)
    if (header !== null) {
      block = header[1].split('.').map(unquote)
      headers.set(block.join('\u0000'), { line: lineNumber + 1, column: line.indexOf('[') + 1, reason: '' })
      continue
    }
    for (const match of line.matchAll(/([A-Za-z0-9_-]+)[ \t]*=/g)) {
      const name = match[1]
      // An inline-table member sits inside a key's value but is addressed as the block's key, which is
      // what the checks below ask for: a predicate is found at the entry table.
      const address = [...block, name].join('\u0000')
      if (!keys.has(address)) keys.set(address, { line: lineNumber + 1, column: match.index + 1, reason: '' })
    }
  }
  return {
    declaration: (at, name) => keys.get([...at, name].join('\u0000')) ?? headers.get([...at, name].join('\u0000')) ?? null,
    header: (at) => headers.get(at.join('\u0000')) ?? null,
  }
}

// A Check is spelled inline (`check = { file = ... }`) or as a table of its own
// (`[provision.<name>.<harness>.check]`), and the scan indexed its members under one of those two
// addresses, so both are tried before falling back to the top of the file.
function decodeCheck(table: EnvironmentTable, block: readonly string[], at: SourceIndex): Decoded<Check> {
  const checkAt = (name: string) => at.declaration(block, name) ?? at.declaration([...block, CHECK_KEY], name)
  for (const key of Object.keys(table)) {
    if (!PREDICATE_KEYS.has(key)) return refused(place(checkAt(key), `unknown predicate '${key}'`))
  }
  // `onPath` names no file, so it is the whole table: written beside `file` it would be two
  // predicates in one and there would be no answer either of them owns.
  if (has(table, ON_PATH_KEY)) {
    const beside = Object.keys(table).find((key) => key !== ON_PATH_KEY)
    if (beside !== undefined) return refused(place(checkAt(beside), `onPath takes no other key, and '${beside}' is one`))
    const onPath = stringValue(table[ON_PATH_KEY])
    if (onPath === null) return refused(place(checkAt(ON_PATH_KEY), 'onPath must be a string'))
    if (onPath === '') return refused(place(checkAt(ON_PATH_KEY), 'onPath is empty'))
    return { ok: true, value: { onPath } }
  }
  if (!has(table, FILE_KEY)) return refused(place(checkAt(FILE_KEY), 'check has no file'))
  const file = stringValue(table[FILE_KEY])
  if (file === null) return refused(place(checkAt(FILE_KEY), 'file must be a string'))
  if (file === '') return refused(place(checkAt(FILE_KEY), 'file is empty'))
  // A Check is one of the four predicates, never two: `contains` and `pointer` answer the same
  // question in two ways, so both spelled at once refuses rather than picking one.
  if (has(table, CONTAINS_KEY) && has(table, POINTER_KEY)) {
    return refused(place(checkAt(POINTER_KEY), 'a check holds contains or pointer, not both'))
  }
  if (has(table, POINTER_KEY)) {
    const pointer = stringValue(table[POINTER_KEY])
    if (pointer === null) return refused(place(checkAt(POINTER_KEY), 'pointer must be a string'))
    if (pointer === '') return refused(place(checkAt(POINTER_KEY), 'pointer is empty'))
    return has(table, EQUALS_KEY)
      ? { ok: true, value: { file, pointer, equals: table[EQUALS_KEY] } }
      : { ok: true, value: { file, pointer } }
  }
  // `equals` compares a value at an address, so on its own it names nothing to compare.
  if (has(table, EQUALS_KEY)) return refused(place(checkAt(EQUALS_KEY), 'equals needs a pointer'))
  if (!has(table, CONTAINS_KEY)) return { ok: true, value: { file } }
  const contains = stringValue(table[CONTAINS_KEY])
  if (contains === null) return refused(place(checkAt(CONTAINS_KEY), 'contains must be a string'))
  if (contains === '') return refused(place(checkAt(CONTAINS_KEY), 'contains is empty'))
  return { ok: true, value: { file, contains } }
}

// One `[provision.<name>.<harness>]` table. `check` and `install` are both required: a Provision is a
// check and a command, and one without the other cannot be converged.
function decodeEntry(
  harness: HarnessId,
  table: EnvironmentTable,
  block: readonly string[],
  at: SourceIndex,
): Decoded<DeclaredEntry> {
  for (const key of Object.keys(table)) {
    if (key !== CHECK_KEY && key !== INSTALL_KEY) return refused(place(at.declaration(block, key), `unknown key '${key}'`))
  }
  if (!has(table, INSTALL_KEY)) return refused(place(at.header(block), 'missing install'))
  const install = stringValue(table[INSTALL_KEY])
  if (install === null) return refused(place(at.declaration(block, INSTALL_KEY), 'install must be a string'))
  if (!has(table, CHECK_KEY)) return refused(place(at.header(block), 'missing check'))
  const checkTable = tableValue(table[CHECK_KEY])
  if (checkTable === null) return refused(place(at.declaration(block, CHECK_KEY), 'check must be an inline table'))
  const check = decodeCheck(checkTable, block, at)
  if (!check.ok) return check
  return { ok: true, value: { harness, check: check.value, install } }
}

function decodeProvision(name: string, table: EnvironmentTable, at: SourceIndex): Decoded<ProvisionDeclaration> {
  const block = [PROVISION_KEY, name]
  const tags = has(table, TAGS_KEY) ? stringList(table[TAGS_KEY]) : []
  if (tags === null) return refused(place(at.declaration(block, TAGS_KEY), 'tags must be an array of strings'))

  const entries: DeclaredEntry[] = []
  for (const key of Object.keys(table)) {
    if (key === TAGS_KEY) continue
    const harness = harnessId(key)
    if (harness === null) return refused(place(at.declaration(block, key), `unknown harness '${key}'`))
    const entry = tableValue(table[key])
    if (entry === null) return refused(place(at.declaration(block, key), `the ${key} entry is not a table`))
    const decoded = decodeEntry(harness, entry, [...block, key], at)
    if (!decoded.ok) return decoded
    entries.push(decoded.value)
  }
  return { ok: true, value: { name, tags, entries } }
}

function firstLine(message: string): string {
  return message.split('\n', 1)[0]
}

// The TOML first, because its own errors carry the position a reader needs. Then the document is
// checked to hold only values this schema can describe: a date or a float in the wrong place is a
// refusal rather than a decoded value nothing downstream expects.
function parseDocument(text: string): Decoded<EnvironmentTable> {
  try {
    const document = TOML_TABLE.safeParse(parse(text))
    if (!document.success) {
      return refused(place(null, 'only strings, numbers, booleans, arrays, and tables are read'))
    }
    return { ok: true, value: document.data }
  } catch (error) {
    if (error instanceof TomlError) {
      return refused({ line: error.line, column: error.column, reason: firstLine(error.message) })
    }
    throw error
  }
}

export function parseEnvironmentFile(text: string): ParseResult {
  const parsed = parseDocument(text)
  if (!parsed.ok) return { ok: false, refusal: parsed.refusal }
  const document = parsed.value
  const at = indexSource(text)

  for (const key of Object.keys(document)) {
    if (key !== VERSION_KEY && key !== PROVISION_KEY) {
      return { ok: false, refusal: place(at.declaration([], key), `unknown key '${key}'`) }
    }
  }
  if (!has(document, VERSION_KEY)) return { ok: false, refusal: place(null, 'version is missing') }
  if (!z.literal(SUPPORTED_VERSION).safeParse(document[VERSION_KEY]).success) {
    const shown = stringValue(document[VERSION_KEY]) ?? JSON.stringify(document[VERSION_KEY])
    return { ok: false, refusal: place(at.declaration([], VERSION_KEY), `version ${shown} is not supported`) }
  }

  // A file with no `[provision]` table declares nothing, which is a legal environment: a dotfiles
  // file for a machine with nothing installed to it yet.
  if (!has(document, PROVISION_KEY)) return { ok: true, provisions: [] }
  const provisions = tableValue(document[PROVISION_KEY])
  if (provisions === null) {
    return { ok: false, refusal: place(at.declaration([], PROVISION_KEY), 'provision must be a table') }
  }

  const decoded: ProvisionDeclaration[] = []
  for (const name of Object.keys(provisions)) {
    const table = tableValue(provisions[name])
    if (table === null) {
      return { ok: false, refusal: place(at.declaration([], PROVISION_KEY), `provision '${name}' is not a table`) }
    }
    const provision = decodeProvision(name, table, at)
    if (!provision.ok) return { ok: false, refusal: provision.refusal }
    decoded.push(provision.value)
  }
  return { ok: true, provisions: decoded }
}
