import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { DiscoveredInstallation, Tier, TierRead } from './types.ts'

export type ParsedEntries<Entry> = { kind: 'ok'; entries: Entry[] } | { kind: 'invalid'; detail: string }

// One problem the harness itself reported, already mapped to the file it came from.
export interface ProbeDiagnostic {
  source: string
  detail: string
}

// A harness that accepts a file and then silently drops it can only be measured by asking it. The
// adapter builds one probe per discovery pass and memoises the answer, so every tier reads the same
// verdict and the harness runs once. `unavailable` is not a failed probe: a machine without the
// binary keeps the local parse's verdict, and the detail says the health is unmeasured.
export type ProbeResult =
  | { kind: 'diagnostics'; diagnostics: ProbeDiagnostic[] }
  | { kind: 'unavailable'; detail: string }

export type TierProbe = () => ProbeResult

// Reads one tier. A tier can have several candidate config files (OpenCode accepts `opencode.json`
// or `.jsonc`, at the repo root and under `.opencode/`), so every one that exists is read. A missing
// file is a healthy empty tier; a file that exists but cannot be read, or that does not parse, makes
// the whole tier unreadable — reported as empty it would tombstone every row the tier had.
export function readTier<Entry>(
  tier: Tier,
  parse: (text: string) => ParsedEntries<Entry>,
  installationFor: (entry: Entry, file: string) => DiscoveredInstallation | null,
  probe?: TierProbe,
): TierRead {
  const installations: DiscoveredInstallation[] = []
  const read: string[] = []
  for (const file of tier.configPaths) {
    // A tier with no config file is a healthy empty tier; a file that exists but cannot be read is
    // not, so it fails closed rather than tombstoning what it hid.
    if (!existsSync(file)) continue
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return { health: 'unreadable', detail: `${file} could not be read`, installations: [] }
    }
    const parsed = parse(text)
    if (parsed.kind === 'invalid') {
      return { health: 'unreadable', detail: `${file}: ${parsed.detail}`, installations: [] }
    }
    read.push(file)
    for (const entry of parsed.entries) {
      const installation = installationFor(entry, file)
      if (installation !== null) installations.push(installation)
    }
  }
  // The parse is the cheapest gate, so nothing is spawned for a tier with no file to judge, and a
  // file that already failed the parse returned above.
  if (probe === undefined || read.length === 0) return { health: 'ok', detail: null, installations }
  const probed = probe()
  if (probed.kind === 'unavailable') {
    return {
      health: 'ok',
      detail: `probe unavailable (${probed.detail}); health is the local parse only`,
      installations,
    }
  }
  const declared = new Set(read.map((file) => path.resolve(file)))
  const fault = probed.diagnostics.find((diagnostic) => declared.has(path.resolve(diagnostic.source)))
  if (fault === undefined) return { health: 'ok', detail: null, installations }
  // The harness rejected the file, so what this tier reports cannot be trusted: it says nothing
  // about the tier and tombstones nothing, exactly as a file that failed the local parse does.
  return { health: 'unreadable', detail: `${fault.source}: ${fault.detail}`, installations: [] }
}
