import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { digestOfPath } from '../digest.ts'
import { classifyWholeFile, withheldMarker } from '../secret.ts'
import { declaredPaths, type DiscoveredInstallation, type Tier, type TierRead } from './types.ts'

// An instruction file's canonical vocabulary is its body, exactly as the spec's `expressible` list
// says. The body is a credential-bearing whole file, so it is scanned line by line before it can
// reach the store: a value that is not clean is persisted as its marker, and a mirror then stops.
export const INSTRUCTION_FIELDS = ['body'] as const

export function readInstructionTier(tier: Tier): TierRead {
  const installations: DiscoveredInstallation[] = []
  for (const file of declaredPaths(tier, 'instructions')) {
    if (!existsSync(file)) continue
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return { health: 'unreadable', detail: `${file} could not be read`, installations: [] }
    }
    const verdict = classifyWholeFile('AGENTS.md', text)
    installations.push({
      category: 'instructions',
      name: path.basename(file),
      scope: tier.scopeBucket,
      tierId: tier.id,
      nativeFile: file,
      nativePointer: '',
      knownFieldsJson: JSON.stringify({
        body: verdict === 'clean' ? text : withheldMarker(verdict),
      }),
      contentDigest: digestOfPath(file) ?? '',
    })
  }
  return { health: 'ok', detail: null, installations }
}
