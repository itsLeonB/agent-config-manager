import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { digestOfPath } from '../digest.ts'
import { classifyWholeFile, withheldMarker } from '../secret.ts'
import { declaredPaths, type DiscoveredDeclaration, type Tier, type TierRead } from './types.ts'

// An instruction file's canonical vocabulary is its body. The body is a credential-bearing whole
// file, so it is scanned line by line before it can reach a declaration: a value that is not clean
// is withheld as its marker.
export function readInstructionTier(tier: Tier): TierRead {
  const declarations: DiscoveredDeclaration[] = []
  for (const file of declaredPaths(tier, 'instructions')) {
    if (!existsSync(file)) continue
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return { health: 'unreadable', detail: `${file} could not be read`, declarations: [] }
    }
    const verdict = classifyWholeFile(path.basename(file), text)
    declarations.push({
      category: 'instructions',
      name: path.basename(file),
      tierId: tier.id,
      nativeFile: file,
      nativePointer: '',
      knownFieldsJson: JSON.stringify({
        body: verdict === 'clean' ? text : withheldMarker(verdict),
      }),
      contentDigest: digestOfPath(file) ?? '',
    })
  }
  return { health: 'ok', detail: null, declarations }
}
