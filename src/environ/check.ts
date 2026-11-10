import { readFileSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { formatOf, readPointer } from '../engine/edit.ts'
import type { Check, CheckAnswer } from './types.ts'

// A Check reads and answers. It never spawns a process, touches the network, or writes: an agent may
// define a Check, so evaluating one has to be inert by construction rather than by convention — the
// `PATH` walk below is `stat`, never `which`.

// What a Check's own file answered: the bytes it read, nothing at all because no file is there, or
// the reason it could not be read. `unreadable` is an answer in its own right, so a file this process
// could not look at never reaches `absent`.
export type FileInput =
  | { kind: 'read'; bytes: string }
  | { kind: 'absent' }
  | { kind: 'unreadable'; detail: string }

// Everything a Check may consult, handed in rather than read here: a test supplies fixture bytes and
// a temp directory standing in for `PATH`, and no part of this module reaches for a real one.
export interface CheckInputs {
  // What the Check's file answered. A Check that names no file (`onPath`) never looks at it.
  file: FileInput
  // The directories `PATH` names, in order.
  pathDirs: readonly string[]
}

// The inputs a running acm hands its own evaluator: the bytes the file has on this machine, and this
// process's `PATH`. Reading that file is the whole I/O a Check causes, besides the `PATH` walk a
// name lookup makes; a caller that has the bytes already passes its own inputs instead.
export function checkInputsOf(check: Check): CheckInputs {
  return {
    file: 'file' in check ? readDeclaredFile(check.file) : { kind: 'absent' },
    pathDirs: (process.env.PATH ?? '').split(delimiter),
  }
}

// One Check's answer on this machine. The status and the run both ask here, so two faces cannot
// disagree about what the same Check says.
export function evaluate(check: Check): CheckAnswer {
  return evaluateCheck(check, checkInputsOf(check))
}

// The one read a Check causes. A file that is not there is an answer — nothing is installed — while
// every other failure means the file may hold what the Check asks about and this process could not
// look: a directory where a file was named, a permission bit, an I/O error. Answering `absent` for
// those is the inversion the third Presence value exists to prevent.
function readDeclaredFile(file: string): FileInput {
  try {
    return { kind: 'read', bytes: readFileSync(file, 'utf8') }
  } catch (error) {
    if (error instanceof Error && isNotFound(error)) return { kind: 'absent' }
    const cause = error instanceof Error ? error.message : String(error)
    return { kind: 'unreadable', detail: `${file} could not be read: ${cause}` }
  }
}

function isNotFound(error: Error): boolean {
  return 'code' in error && error.code === 'ENOENT'
}

export function evaluateCheck(check: Check, inputs: CheckInputs): CheckAnswer {
  if ('onPath' in check) return onPath(check.onPath, inputs.pathDirs)
  const { file } = inputs
  if (file.kind === 'unreadable') return { presence: 'unknown', detail: file.detail }
  if (file.kind === 'absent') return { presence: 'absent', detail: null }
  const { bytes } = file
  if ('contains' in check) return containsAnswer(check.contains, bytes)
  if (!('pointer' in check)) return { presence: 'present', detail: null }
  const read = readPointer(bytes, formatOf(check.file), check.pointer.split('.'))
  if (read.kind === 'invalid') return { presence: 'unknown', detail: `${check.file} could not be read: ${read.reason}` }
  if (read.kind === 'missing') return { presence: 'absent', detail: null }
  // `equals` is why an entry that is present but switched off is not an installed one: the address
  // exists, and its value still has to be the value the Provision means.
  if ('equals' in check && !isDeepStrictEqual(read.value, check.equals)) return { presence: 'absent', detail: null }
  return { presence: 'present', detail: null }
}

function containsAnswer(pattern: string, bytes: string): CheckAnswer {
  let expression: RegExp
  try {
    // Multiline, so `^` anchors at the start of a line: an export in a profile and a heading in a
    // markdown file are both addressed by the line they sit on.
    expression = new RegExp(pattern, 'm')
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { presence: 'unknown', detail: `invalid pattern ${pattern}: ${reason}` }
  }
  return { presence: expression.test(bytes) ? 'present' : 'absent', detail: null }
}

// A name is present only as a regular executable file, which is the test a shell's own lookup makes.
// A name that is not on PATH, or is there without the executable bit, is absent; a PATH entry that
// cannot be searched is the one case that answers `unknown`, because a name that might sit in it was
// not looked for.
function onPath(name: string, pathDirs: readonly string[]): CheckAnswer {
  let unsearchable: string | null = null
  for (const directory of pathDirs) {
    let searchable: boolean
    try {
      searchable = statSync(directory).isDirectory()
    } catch (error) {
      unsearchable ??= `${directory}: ${error instanceof Error ? error.message : String(error)}`
      continue
    }
    if (!searchable) {
      unsearchable ??= `${directory} is not a directory`
      continue
    }
    try {
      const candidate = statSync(join(directory, name))
      if (candidate.isFile() && (candidate.mode & 0o111) !== 0) return { presence: 'present', detail: null }
    } catch {
      // The name is not in this directory, and a later one may hold it.
    }
  }
  if (unsearchable === null) return { presence: 'absent', detail: null }
  return { presence: 'unknown', detail: `PATH could not be searched: ${unsearchable}` }
}
