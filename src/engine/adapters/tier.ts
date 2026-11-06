import { existsSync, readFileSync } from 'node:fs'
import type { DiscoveredInstallation, Tier, TierRead } from './types.ts'

export type ParsedEntries<Entry> = { kind: 'ok'; entries: Entry[] } | { kind: 'invalid'; detail: string }

// Reads one tier. A tier can have several candidate config files (OpenCode accepts `opencode.json`
// or `.jsonc`, at the repo root and under `.opencode/`), so every one that exists is read. A missing
// file is a healthy empty tier; a file that exists but cannot be read, or that does not parse, makes
// the whole tier unreadable — reported as empty it would tombstone every row the tier had.
export function readTier<Entry>(
  tier: Tier,
  parse: (text: string) => ParsedEntries<Entry>,
  installationFor: (entry: Entry, file: string) => DiscoveredInstallation | null,
): TierRead {
  const installations: DiscoveredInstallation[] = []
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
    for (const entry of parsed.entries) {
      const installation = installationFor(entry, file)
      if (installation !== null) installations.push(installation)
    }
  }
  return { health: 'ok', detail: null, installations }
}
