// One module owns where a Section starts and ends, so a Check that compares one and an install
// that rewrites one cannot disagree about the span. A Section runs from its `## ` heading — the
// heading the Payload's first `## ` line spells — through the line before the next `## ` heading;
// a `## ` line inside a backtick-fenced code block neither starts nor ends one, and `### ` headings
// do not end one.

// The line that heads a Section: the Payload's first line starting with `## ` outside a backtick
// fence, the same walk `readSection` makes, so the heading a Check looks up is the heading this
// spells. Null when the Payload has none, which is a Check that cannot be answered and an install
// that cannot be written.
export function headingOf(text: string): string | null {
  let fenced = false
  for (const line of text.split('\n')) {
    if (/^\s*`{3,}/.test(line)) {
      fenced = !fenced
      continue
    }
    if (!fenced && line.trimStart().startsWith('## ')) return line.trimEnd()
  }
  return null
}

// One Section's location: `start` is the heading line's first byte and `end` is just past the
// Section's last byte, so `text.slice(start, end)` is the whole Section.
export type SectionRead =
  | { kind: 'found'; text: string; start: number; end: number }
  | { kind: 'missing' }
  | { kind: 'ambiguous' }

// Where the Section with this heading is, that it is not there, or that two Sections share the
// heading. A backtick fence — a line whose first non-whitespace bytes are three backticks, the
// fence the native instruction files use — is tracked, so a `## ` line inside one is body text;
// `~~~` is not a fence this reads, so a `## ` line inside a tilde block does end a Section.
export function readSection(text: string, heading: string): SectionRead {
  const lines = text.split('\n')
  let fenced = false
  let start: number | null = null
  let offset = 0
  for (const line of lines) {
    if (/^\s*`{3,}/.test(line)) {
      fenced = !fenced
      offset += line.length + 1
      continue
    }
    const content = line.trimEnd()
    if (fenced) {
      offset += line.length + 1
      continue
    }
    if (content === heading) {
      if (start !== null) return { kind: 'ambiguous' }
      start = offset
      offset += line.length + 1
      continue
    }
    if (start !== null && content.startsWith('## ')) {
      return { kind: 'found', text: text.slice(start, offset), start, end: offset }
    }
    offset += line.length + 1
  }
  return start === null ? { kind: 'missing' } : { kind: 'found', text: text.slice(start), start, end: text.length }
}

// Trailing blank lines carry no meaning, so a Section an editor padded with empty lines still
// matches the Payload whose text ends where the words end. Only the trailing end is stripped: every
// other byte has to match.
export function stripTrailingBlankLines(text: string): string {
  const lines = text.split('\n')
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  return lines.join('\n')
}

export type SectionWrite = { ok: true; text: string } | { ok: false; reason: string }

// The whole write in one function: the Section's span is replaced with the Payload's text, or the
// Payload is appended — after a newline when the file does not end with one — when the Section is
// missing, which also creates the file the caller had none of. Every byte outside the span is the
// byte it was.
export function rewriteSection(fileText: string, payloadText: string, heading: string): SectionWrite {
  const found = readSection(fileText, heading)
  if (found.kind === 'ambiguous') return { ok: false, reason: `two Sections headed ${heading}` }
  if (found.kind === 'missing') {
    const text = fileText === '' ? payloadText : fileText.endsWith('\n') ? fileText + payloadText : fileText + '\n' + payloadText
    return { ok: true, text }
  }
  const tail = fileText.slice(found.end)
  // The comparator strips trailing blank lines on both sides, so a Payload whose last byte is not a
  // newline is a value that has to converge. With a tail to protect — the next Section's heading —
  // the Payload is newline-terminated so the two never fuse into one line; at end of file it lands
  // as it is, with no trailing newline added.
  const payload = tail === '' || payloadText.endsWith('\n') ? payloadText : `${payloadText}\n`
  return { ok: true, text: fileText.slice(0, found.start) + payload + tail }
}
