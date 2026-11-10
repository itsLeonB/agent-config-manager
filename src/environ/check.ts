import type { Check, CheckAnswer } from './types.ts'

// A Check reads and answers. It never spawns a process, touches the network, or writes: an agent may
// define a Check, so evaluating one has to be inert by construction rather than by convention. The
// bytes are passed in for that reason — this module does no I/O at all.

// `null` means the file was not there. `{ file }` answers that, and `contains` has nothing to match.
export function evaluateCheck(check: Check, bytes: string | null): CheckAnswer {
  if (bytes === null) return { presence: 'absent', detail: null }
  if (!('contains' in check)) return { presence: 'present', detail: null }
  let pattern: RegExp
  try {
    // Multiline, so `^` anchors at the start of a line: an export in a profile and a heading in a
    // markdown file are both addressed by the line they sit on.
    pattern = new RegExp(check.contains, 'm')
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { presence: 'unknown', detail: `invalid pattern ${check.contains}: ${reason}` }
  }
  return { presence: pattern.test(bytes) ? 'present' : 'absent', detail: null }
}
