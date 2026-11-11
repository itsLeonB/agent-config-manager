import { parse, TomlError } from 'smol-toml'
import { z } from 'zod'
import { splitPointer } from '../engine/edit.ts'
import type { Check, DeclaredEntry, InstallCommand, ParseResult, ProvisionDeclaration, Refusal } from './types.ts'

// The parser is total against the closed environment-file schema: every value in the document is
// either decoded into a Provision or refuses the whole file with the line and column of the part at
// fault. A refusal is a value, not a thrown error, so a loader can drop one file and keep the others.

const SUPPORTED_VERSION = 1
const VERSION_KEY = 'version'
const PROVISION_KEY = 'provision'
const TAGS_KEY = 'tags'
const CHECK_KEY = 'check'
const CHECKS_KEY = 'checks'
const INSTALL_KEY = 'install'
const PAYLOAD_KEY = 'payload'
const ARGS_KEY = 'args'
const FILE_KEY = 'file'
const CONTAINS_KEY = 'contains'
const POINTER_KEY = 'pointer'
const EQUALS_KEY = 'equals'
const INCLUDES_KEY = 'includes'
const ON_PATH_KEY = 'onPath'
const SECTION_KEY = 'section'
// The closed predicate set: the keys a Check may carry besides `file`. Anything else is a typo and
// refuses the file, so a Check ACM does not understand is never silently ignored.
const PREDICATE_KEYS: ReadonlySet<string> = new Set([
  FILE_KEY,
  CONTAINS_KEY,
  POINTER_KEY,
  EQUALS_KEY,
  INCLUDES_KEY,
  SECTION_KEY,
  ON_PATH_KEY,
])

// TOML can hold dates and big integers; this schema describes strings, numbers, booleans, arrays, and
// tables, which is every value an environment file is allowed to write.
const TOML_TABLE = z.record(z.string(), z.json())
type EnvironmentTable = z.infer<typeof TOML_TABLE>
type EnvironmentValue = EnvironmentTable[string]

type Decoded<T> = { ok: true; value: T } | { ok: false; refusal: Refusal }

function refused<T>(refusal: Refusal): Decoded<T> {
  return { ok: false, refusal }
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

// A Check is spelled inline (`check = { file = ... }` or a member of `checks = [ … ]`) or as a table
// of its own (`[provision.<name>.<harness>.check]`), and the scan indexed its members under one of
// those addresses, so all three are tried before falling back to the top of the file.
function decodeCheck(table: EnvironmentTable, block: readonly string[], at: SourceIndex): Decoded<Check> {
  const checkAt = (name: string) =>
    at.declaration(block, name) ??
    at.declaration([...block, CHECK_KEY], name) ??
    at.declaration([...block, CHECKS_KEY], name)
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
  // A Check is one of the six predicates, never two: `contains` and `pointer` answer the same
  // question in two ways, so both spelled at once refuses rather than picking one. `equals` and
  // `includes` are the two answers a pointer Check may give, so one Check holds one of them, and
  // neither sits beside `contains` for the same reason. `section` names a Payload, so it stands
  // alone with its `file`.
  if (has(table, CONTAINS_KEY) && has(table, POINTER_KEY)) {
    return refused(place(checkAt(POINTER_KEY), 'a check holds contains or pointer, not both'))
  }
  if (has(table, INCLUDES_KEY) && has(table, EQUALS_KEY)) {
    return refused(place(checkAt(INCLUDES_KEY), 'a check holds equals or includes, not both'))
  }
  if (has(table, INCLUDES_KEY) && has(table, CONTAINS_KEY)) {
    return refused(place(checkAt(INCLUDES_KEY), 'a check holds contains or includes, not both'))
  }
  if (has(table, SECTION_KEY)) {
    const beside = Object.keys(table).find((key) => key !== FILE_KEY && key !== SECTION_KEY)
    if (beside !== undefined) return refused(place(checkAt(beside), `a check holds section or ${beside}, not both`))
    const section = stringValue(table[SECTION_KEY])
    if (section === null) return refused(place(checkAt(SECTION_KEY), 'section must be a string'))
    if (section === '') return refused(place(checkAt(SECTION_KEY), 'section is empty'))
    return { ok: true, value: { file, section } }
  }
  if (has(table, POINTER_KEY)) {
    const pointer = stringValue(table[POINTER_KEY])
    if (pointer === null) return refused(place(checkAt(POINTER_KEY), 'pointer must be a string'))
    if (pointer === '') return refused(place(checkAt(POINTER_KEY), 'pointer is empty'))
    // A pointer the splitter cannot spell is an address ACM cannot read, so the file refuses here
    // rather than a Check answering `absent` for something it never looked at.
    try {
      splitPointer(pointer)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return refused(place(checkAt(POINTER_KEY), `pointer cannot be spelled: ${reason}`))
    }
    if (has(table, INCLUDES_KEY)) return { ok: true, value: { file, pointer, includes: table[INCLUDES_KEY] } }
    return has(table, EQUALS_KEY)
      ? { ok: true, value: { file, pointer, equals: table[EQUALS_KEY] } }
      : { ok: true, value: { file, pointer } }
  }
  // `equals` and `includes` compare what sits at an address, so on their own they name nothing to
  // compare.
  if (has(table, INCLUDES_KEY)) return refused(place(checkAt(INCLUDES_KEY), 'includes needs a pointer'))
  if (has(table, EQUALS_KEY)) return refused(place(checkAt(EQUALS_KEY), 'equals needs a pointer'))
  if (!has(table, CONTAINS_KEY)) return { ok: true, value: { file } }
  const contains = stringValue(table[CONTAINS_KEY])
  if (contains === null) return refused(place(checkAt(CONTAINS_KEY), 'contains must be a string'))
  if (contains === '') return refused(place(checkAt(CONTAINS_KEY), 'contains is empty'))
  return { ok: true, value: { file, contains } }
}

// `check`/`checks` spelled at one level — a Provision's own table or a harness entry. Either
// spelling decodes to the same list; `check = { … }` is the one-element spelling, so a file written
// before the list keeps loading. Returns null when neither key is spelled: whether that is a fault
// depends on the level's shared declarations, which only the caller knows.
function decodeChecks(
  table: EnvironmentTable,
  block: readonly string[],
  at: SourceIndex,
  bothReason: string,
): Decoded<Check[]> | null {
  if (has(table, CHECK_KEY) && has(table, CHECKS_KEY)) {
    return refused(place(at.declaration(block, CHECKS_KEY), bothReason))
  }
  if (has(table, CHECK_KEY)) {
    const checkTable = tableValue(table[CHECK_KEY])
    if (checkTable === null) return refused(place(at.declaration(block, CHECK_KEY), 'check must be an inline table'))
    const check = decodeCheck(checkTable, block, at)
    if (!check.ok) return check
    return { ok: true, value: [check.value] }
  }
  if (!has(table, CHECKS_KEY)) return null
  const checksList = z.array(TOML_TABLE).safeParse(table[CHECKS_KEY])
  if (!checksList.success) {
    return refused(place(at.declaration(block, CHECKS_KEY), 'checks must be an array of tables'))
  }
  if (checksList.data.length === 0) return refused(place(at.declaration(block, CHECKS_KEY), 'checks is empty'))
  const checks: Check[] = []
  for (const checkTable of checksList.data) {
    const check = decodeCheck(checkTable, block, at)
    if (!check.ok) return check
    checks.push(check.value)
  }
  return { ok: true, value: checks }
}

// One `[provision.<name>.<harness>]` table. Its own `checks` and `install` are optional: the
// Provision's shared declarations may cover them, and `decodeProvision` refuses the file when an
// entry would end up with no effective Check or Install command.
function decodeEntry(
  harness: string,
  table: EnvironmentTable,
  block: readonly string[],
  at: SourceIndex,
): Decoded<DeclaredEntry> {
  for (const key of Object.keys(table)) {
    if (key !== CHECK_KEY && key !== CHECKS_KEY && key !== INSTALL_KEY) {
      return refused(place(at.declaration(block, key), `unknown key '${key}'`))
    }
  }
  let install: InstallCommand | null = null
  if (has(table, INSTALL_KEY)) {
    const decoded = decodeInstall(table[INSTALL_KEY], block, at)
    if (!decoded.ok) return decoded
    install = decoded.value
  }
  const checks = decodeChecks(table, block, at, 'an entry holds check or checks, not both')
  if (checks !== null && !checks.ok) return checks
  return { ok: true, value: { harness, checks: checks === null ? [] : checks.value, install } }
}

// `install` is the one command ACM ever executes, and it is either spelled in the file, a
// Payload, or a Section write: `{ payload = "<path>" [, args = [ … ]] }` or
// `{ file = "<native file>", section = "<payload>" }`. The set of keys is closed the way a Check's
// predicates are, so a shape the parser does not understand refuses the file rather than being
// half-read.
function decodeInstall(
  value: EnvironmentValue | undefined,
  block: readonly string[],
  at: SourceIndex,
): Decoded<InstallCommand> {
  const asString = stringValue(value)
  if (asString !== null) {
    // An empty command is a Provision that says nothing to do, which is a declaration the file does
    // not mean: every other declared string refuses empty, and an empty one spawns a shell that
    // succeeds at nothing.
    if (asString === '') return refused(place(at.declaration(block, INSTALL_KEY), 'install is empty'))
    return { ok: true, value: asString }
  }
  const table = tableValue(value)
  if (table === null) return refused(place(at.declaration(block, INSTALL_KEY), 'install must be a string or a table'))
  for (const key of Object.keys(table)) {
    if (key !== PAYLOAD_KEY && key !== ARGS_KEY && key !== FILE_KEY && key !== SECTION_KEY) {
      return refused(place(at.declaration(block, key), `unknown install key '${key}'`))
    }
  }
  // The Section shape is `{ file, section }`, nothing beside it: a Payload beside it contradicts,
  // and arguments have no Payload to reach.
  if (has(table, FILE_KEY)) {
    const beside = Object.keys(table).find((key) => key !== FILE_KEY && key !== SECTION_KEY)
    if (beside !== undefined) {
      return refused(place(at.declaration(block, beside), `a section install holds file and section, not ${beside}`))
    }
    if (!has(table, SECTION_KEY)) return refused(place(at.declaration(block, INSTALL_KEY), 'install has no section'))
    const file = stringValue(table[FILE_KEY])
    if (file === null) return refused(place(at.declaration(block, FILE_KEY), 'file must be a string'))
    if (file === '') return refused(place(at.declaration(block, FILE_KEY), 'file is empty'))
    const section = stringValue(table[SECTION_KEY])
    if (section === null) return refused(place(at.declaration(block, SECTION_KEY), 'section must be a string'))
    if (section === '') return refused(place(at.declaration(block, SECTION_KEY), 'section is empty'))
    return { ok: true, value: { file, section } }
  }
  if (has(table, SECTION_KEY)) return refused(place(at.declaration(block, SECTION_KEY), 'section needs a file'))
  if (!has(table, PAYLOAD_KEY)) return refused(place(at.declaration(block, INSTALL_KEY), 'install has no payload'))
  const payload = stringValue(table[PAYLOAD_KEY])
  if (payload === null) return refused(place(at.declaration(block, PAYLOAD_KEY), 'payload must be a string'))
  if (payload === '') return refused(place(at.declaration(block, PAYLOAD_KEY), 'payload is empty'))
  if (!has(table, ARGS_KEY)) return { ok: true, value: { payload } }
  const args = stringList(table[ARGS_KEY])
  if (args === null) return refused(place(at.declaration(block, ARGS_KEY), 'args must be an array of strings'))
  return { ok: true, value: { payload, args } }
}

function decodeProvision(name: string, table: EnvironmentTable, at: SourceIndex): Decoded<ProvisionDeclaration> {
  const block = [PROVISION_KEY, name]
  const tags = has(table, TAGS_KEY) ? stringList(table[TAGS_KEY]) : []
  if (tags === null) return refused(place(at.declaration(block, TAGS_KEY), 'tags must be an array of strings'))

  // The Provision's own `checks` and `install` are the shared declarations every entry inherits.
  // They are optional here and required in effect: an entry with no Checks of its own is covered
  // by these, and one with neither refuses the file below.
  const sharedChecks = decodeChecks(table, block, at, 'a provision holds check or checks, not both')
  if (sharedChecks !== null && !sharedChecks.ok) return sharedChecks
  let sharedInstall: InstallCommand | null = null
  if (has(table, INSTALL_KEY)) {
    const install = decodeInstall(table[INSTALL_KEY], block, at)
    if (!install.ok) return install
    sharedInstall = install.value
  }

  const entries: DeclaredEntry[] = []
  for (const key of Object.keys(table)) {
    const value = table[key]
    const entryTable = tableValue(value)
    const looksLikeEntry =
      entryTable !== null &&
      (has(entryTable, CHECK_KEY) || has(entryTable, CHECKS_KEY) || has(entryTable, INSTALL_KEY))
    const isSharedKey =
      (key === TAGS_KEY || key === CHECK_KEY || key === CHECKS_KEY || key === INSTALL_KEY) && !looksLikeEntry
    if (isSharedKey) continue
    if (key === '' || key.includes('\u0000')) {
      return refused(place(at.declaration(block, key), `harness '${key}' must be non-empty and NUL-free`))
    }
    const harness = key
    const entry = tableValue(table[key])
    if (entry === null) return refused(place(at.declaration(block, key), `the ${key} entry is not a table`))
    const entryBlock = [...block, key]
    const decoded = decodeEntry(harness, entry, entryBlock, at)
    if (!decoded.ok) return decoded
    // An entry's effective Install commands are the shared one plus its own, and its effective
    // Checks the shared ones plus its own: the file refuses when either set would be empty.
    // An entry is a table header or an inline `pi = { … }` key; `declaration` finds either, where
    // `header` would miss the inline spelling and report the fault at the top of the file.
    if (sharedInstall === null && decoded.value.install === null) {
      return refused(place(at.declaration(block, key), 'missing install'))
    }
    if ((sharedChecks === null ? 0 : sharedChecks.value.length) + decoded.value.checks.length === 0) {
      return refused(place(at.declaration(block, key), 'missing check'))
    }
    entries.push(decoded.value)
  }
  return {
    ok: true,
    value: {
      name,
      tags,
      checks: sharedChecks === null ? [] : sharedChecks.value,
      install: sharedInstall,
      entries,
    },
  }
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

function parseHarnessList(document: EnvironmentTable, at: SourceIndex): Decoded<string[]> {
  const HARNESS_LIST_KEY = 'harnesses'
  if (!has(document, HARNESS_LIST_KEY)) return { ok: true, value: [] }
  const list = stringList(document[HARNESS_LIST_KEY])
  if (list === null) {
    return refused(place(at.declaration([], HARNESS_LIST_KEY), 'harnesses must be an array of strings'))
  }
  for (const name of list) {
    if (name === '' || name.includes('\u0000')) {
      return refused(place(at.declaration([], HARNESS_LIST_KEY), 'harnesses must be non-empty, NUL-free strings'))
    }
  }
  return { ok: true, value: list }
}

export function parseEnvironmentFile(text: string): ParseResult {
  const parsed = parseDocument(text)
  if (!parsed.ok) return { ok: false, refusal: parsed.refusal }
  const document = parsed.value
  const at = indexSource(text)

  const HARNESS_LIST_KEY = 'harnesses'
  for (const key of Object.keys(document)) {
    if (key !== VERSION_KEY && key !== PROVISION_KEY && key !== HARNESS_LIST_KEY) {
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
  const declaredHarnesses = parseHarnessList(document, at)
  if (!declaredHarnesses.ok) return { ok: false, refusal: declaredHarnesses.refusal }
  if (!has(document, PROVISION_KEY)) return { ok: true, provisions: [], harnesses: declaredHarnesses.value }
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
  return { ok: true, provisions: decoded, harnesses: declaredHarnesses.value }
}
