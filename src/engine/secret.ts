// The engine's one ordered rule table for credential detection. It runs over source bytes before a
// value reaches known fields, a plan, a tool result, an elicitation form, or a log line, so a human
// or an agent reading an inspection can trust that no token arrived with it.
//
// Entropy is split by alphabet on purpose: hex caps at 4.0 bits per character and a base64 key
// sits at 4.33-4.75, so one threshold either flags every hash or misses every hex key.

export type Verdict = 'clean' | 'suspect' | 'secret'

export interface Classification {
  verdict: Verdict
  // Pi's `!command` retrieves a secret by running a program: the value carries no credential, but
  // a writer must still treat it as executable.
  executable: boolean
}

// A pointer the adapter's native surface treats as credential-bearing. `kind: 'leaf'` names a value
// that must never leave the engine; `kind: 'file'` names a whole file whose text has to be scanned.
export interface CredentialPointer {
  pointer: string
  kind: 'leaf' | 'file'
}

const CLEAN: Classification = { verdict: 'clean', executable: false }
const SUSPECT: Classification = { verdict: 'suspect', executable: false }
const SECRET: Classification = { verdict: 'secret', executable: false }
const SECRET_COMMAND: Classification = { verdict: 'secret', executable: true }

// The harness's own secret-free forms. A value that is only a reference plus a scheme word carries
// no credential, so it is clean even at a credential pointer: Pi's `${VAR}` and `!command`, and
// OpenCode's `{env:VAR}` and `{file:path}`.
const REFERENCE = /\$\{[A-Za-z_]\w*\}|\$[A-Za-z_]\w*|\{env:[A-Za-z_]\w*\}|\{file:[^}\s]+\}/g
const REFERENCE_WORD = /\b(?:bearer|token|basic|digest|headers?)\b/gi
const REFERENCE_NOISE = /[\s"'`,:;=()[\]<>]/g

// Length-anchored provider patterns, instanced from gitleaks' master config against the three
// harnesses' own config surfaces.
const PROVIDER_TOKEN = new RegExp(
  [
    String.raw`\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}`,
    String.raw`\b(?:sk|rk)_(?:test|live|prod)_[A-Za-z0-9]{10,}`,
    String.raw`\bgh[pousr]_[A-Za-z0-9]{36}`,
    String.raw`\bgithub_pat_[A-Za-z0-9_]{20,}`,
    // AWS key ids are documented as [A-Z2-7], but the vendor's own sample and real ids carry O and
    // I, so the wider alphabet is the one that matches what is on disk.
    String.raw`\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}`,
    String.raw`\bxox[abposre]-[A-Za-z0-9-]{10,}`,
    String.raw`\bxapp-[A-Za-z0-9-]{10,}`,
    String.raw`\bnpm_[a-z0-9]{36}`,
    String.raw`\bpypi-[A-Za-z0-9_-]{20,}`,
    String.raw`\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}`,
    // A URL is not a credential, but basic-auth userinfo is.
    String.raw`[a-z][a-z0-9+.-]*://[^\s/@:]+:[^\s/@]+@`,
  ].join('|'),
  'i',
)

const PEM_PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/

const DIGEST_VALUE =
  /^(?:[0-9a-f]{32,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?:sha1|sha256|sha512):\S+|[0-9A-HJKMNP-TV-Z]{26})$/i
const DIGEST_NAME = /(?:hash|digest|checksum|fingerprint|id)$/i

const CREDENTIAL_NAME = /(?:api[-_]?key|token|secret|passw(?:or)?d|credential|bearer|authorization)/i
const BASE64_VALUE = /^[A-Za-z0-9+/=_-]{20,}$/
const LONG_HEX = /^[0-9a-f]{32,}$/i

const BASE64_ENTROPY = 4.4
const HEX_ENTROPY = 3.0

export function classify(
  pointer: string,
  value: string,
  pointers: readonly CredentialPointer[],
): Classification {
  // Rule 1 first, ahead of the pointer check the settled table lists above it: a reference is
  // secret-free by construction, so an env entry holding `${VAR}` must not be withheld — that is
  // the whole point of the harness providing the indirection.
  if (value.startsWith('!')) {
    // A command cannot launder the credential it was written to retrieve.
    return PROVIDER_TOKEN.test(value) || PEM_PRIVATE_KEY.test(value) ? SECRET_COMMAND : {
      verdict: 'clean',
      executable: true,
    }
  }
  if (isReference(value)) return CLEAN
  // Rule 0: the adapter declares these as credential-bearing.
  if (isCredentialPointer(pointer, pointers)) return SECRET
  // Rules 2 and 3: a provider token or a private-key block is a secret wherever it sits.
  if (PROVIDER_TOKEN.test(value) || PEM_PRIVATE_KEY.test(value)) return SECRET

  const name = pointerName(pointer)
  // Rule 4: a digest under a digest-shaped name. Mandatory rather than optional: Codex's
  // `hooks.state.*.trusted_hash` is the largest class of entropy hits on the real corpus.
  if (DIGEST_VALUE.test(value) && DIGEST_NAME.test(name)) return CLEAN
  // Rule 5: a credential-shaped name alone is a suspicion, but long hex is left to rule 7 so a
  // digest under a credential name is judged on its entropy rather than on its name.
  if (CREDENTIAL_NAME.test(name) && value.length >= 8 && !LONG_HEX.test(value)) return SUSPECT
  // Rule 6: base64-shaped, gated by the alphabet it is drawn from.
  if (BASE64_VALUE.test(value) && /[0-9]/.test(value) && /[A-Z]/.test(value)) {
    if (entropy(value) >= BASE64_ENTROPY) return SUSPECT
  }
  // Rule 7: hex cannot reach rule 6's threshold, so it gets its own bar and still needs the name.
  if (LONG_HEX.test(value) && entropy(value) >= HEX_ENTROPY && CREDENTIAL_NAME.test(name)) {
    return SUSPECT
  }
  // Rule 8.
  return CLEAN
}

// A whole-file category (`SKILL.md`, `AGENTS.md`, a generated plugin) has no leaves, so the file's
// own text is the value. Every line goes through the same table; a `key = value` line keeps its key
// as the pointer, so a credential-shaped name inside a file is still judged on its name.
export function classifyWholeFile(pointer: string, text: string): Verdict {
  let verdict: Verdict = 'clean'
  for (const line of text.split('\n')) {
    const assignment = ASSIGNMENT.exec(line)
    const lineVerdict =
      assignment === null
        ? classify(pointer, line.trim(), []).verdict
        : classify(`${pointer}.${assignment[1] ?? ''}`, (assignment[2] ?? '').trim(), []).verdict
    if (lineVerdict === 'secret') return 'secret'
    if (lineVerdict === 'suspect') verdict = 'suspect'
  }
  return verdict
}

// `api_token = …`, `"secret": "…"`, `password: …` — the key is what a rule needs to judge the line.
const ASSIGNMENT = /^\s*["']?([\w.$-]+)["']?\s*[:=]\s*(.+)$/

// The marker a withheld value becomes in known fields, so a stored row carries the verdict next to
// the pointer it belongs to and inspect needs no side table.
export function withheldMarker(verdict: Exclude<Verdict, 'clean'>): string {
  return `[withheld: ${verdict}]`
}

const WITHHELD_MARKER = /^\[withheld: (secret|suspect)\]/

export function storedVerdict(value: string): Verdict {
  const match = WITHHELD_MARKER.exec(value)
  if (match === null) return 'clean'
  return match[1] === 'secret' ? 'secret' : 'suspect'
}

function isCredentialPointer(pointer: string, pointers: readonly CredentialPointer[]): boolean {
  return pointers.some((declared) =>
    declared.kind !== 'leaf'
      ? false
      : declared.pointer.endsWith('.*')
        ? pointer.startsWith(declared.pointer.slice(0, -1))
        : pointer === declared.pointer,
  )
}

function isReference(value: string): boolean {
  if (value.match(REFERENCE) === null) return false
  const remainder = value
    .replace(REFERENCE, '')
    .replace(REFERENCE_WORD, '')
    .replace(REFERENCE_NOISE, '')
  return remainder === ''
}

// The last step of a pointer, unquoted: `mcpServers."dotted.name"` names `dotted.name`.
function pointerName(pointer: string): string {
  const last = pointer.slice(pointer.lastIndexOf('.') + 1)
  return last.replace(/^"|"$/g, '').replace(/\\(.)/g, '$1')
}

// Shannon entropy per character: how many bits one more unknown character would cost.
function entropy(value: string): number {
  const counts = new Map<string, number>()
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1)
  let total = 0
  for (const count of counts.values()) {
    const share = count / value.length
    total -= share * Math.log2(share)
  }
  return total
}
