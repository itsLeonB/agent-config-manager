import { statSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { formatOf, readPointer } from '../engine/edit.ts'
import type { Check, CheckAnswer } from './types.ts'

// A Check reads and answers. It never spawns a process, touches the network, or writes: an agent may
// define a Check, so evaluating one has to be inert by construction rather than by convention — the
// `PATH` walk below is `stat`, never `which`.

// Everything a Check may consult, handed in rather than read here: a test supplies fixture bytes and
// a temp directory standing in for `PATH`, and no part of this module reaches for a real one.
export interface CheckInputs {
  // `null` means the file was not there, which is an absence and not an unanswered question.
  bytes: string | null
  // The directories `PATH` names, in order.
  pathDirs: readonly string[]
}

export function evaluateCheck(check: Check, inputs: CheckInputs): CheckAnswer {
  if ('onPath' in check) return onPath(check.onPath, inputs.pathDirs)
  const { bytes } = inputs
  if (bytes === null) return { presence: 'absent', detail: null }
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
