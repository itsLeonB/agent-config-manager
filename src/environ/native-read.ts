import { z } from 'zod'
import type { EngineConfig } from '../engine/config.ts'
import { resolveDefaultConfig } from '../engine/config.ts'
import { createAdapters } from '../engine/adapters/registry.ts'
import {
  HARNESSES,
  declaredPaths,
  type Adapter,
  type Category,
  type CategoryHandler,
  type DiscoveredDeclaration,
  type HarnessId,
  type Tier,
  type TierHealthStatus,
} from '../engine/adapters/types.ts'
import { nativeValueSchema, type NativeValue } from '../engine/native-value.ts'

// What one harness declares at the paths its own read lookup names, live and unstored. The paths
// come from the tier table the readers read through, so a location added there is answered here
// without a second list; the declarations come from those same readers, so every value is already
// through the secret classifier and a credentialed one is its verdict marker.

const HARNESS_ID = z.enum(HARNESSES)

// One category's read of one tier. `paths` is every location the lookup declares for the category,
// whether or not anything sits there, because the answer an agent authoring a Provision needs is
// the address to write to. A file that exists and does not parse makes the whole read `unreadable`
// with its file named in `detail`: reported as an empty list it would say "nothing declared" about
// bytes nobody could parse.
export interface NativePathRead {
  category: Category
  paths: readonly string[]
  health: TierHealthStatus
  detail: string | null
}

// One declaration as the harness's own file spells it. `file` and `pointer` are the native location
// a Provision's check has to name, written the way the pointer-level editor reads it: dotted
// segments, a segment holding a dot quoted. `pointer` is empty where the file (or skill directory)
// is the whole location. `fields` is the reader's projection, credential values replaced by markers.
export interface NativeDeclaration {
  category: Category
  name: string
  file: string
  pointer: string
  fields: NativeValue
}

export interface NativeTierRead {
  tier: string
  // The layer's own name (`user`, `project`, `/etc/opencode`), because the id is prefixed with the
  // harness and a human reading one tier wants the layer it is.
  label: string
  reads: NativePathRead[]
  declarations: NativeDeclaration[]
}

export interface NativeRead {
  harness: HarnessId
  tiers: NativeTierRead[]
}

// One harness, one tier or all of them. Throws — rather than answering empty — for a harness or a
// tier the lookup does not declare, because an empty answer reads as "nothing is configured".
export function readNativeConfig(
  harnessName: string,
  tierId?: string,
  config: EngineConfig = resolveDefaultConfig(),
): NativeRead {
  const harness = HARNESS_ID.safeParse(harnessName)
  if (!harness.success) {
    throw new Error(`unknown harness '${harnessName}'; harnesses are ${HARNESSES.join(', ')}`)
  }
  const adapter = adapterFor(harness.data, config)
  if (tierId !== undefined && !adapter.tiers.some((tier) => tier.id === tierId)) {
    const declared = adapter.tiers.map((tier) => tier.id).join(', ')
    throw new Error(`${harness.data} declares no tier '${tierId}'; tiers are ${declared}`)
  }
  return {
    harness: harness.data,
    tiers: adapter.tiers
      .filter((tier) => tierId === undefined || tier.id === tierId)
      .map((tier) => nativeTierRead(adapter, tier)),
  }
}

function adapterFor(harness: HarnessId, config: EngineConfig): Adapter {
  const adapter = createAdapters(config).find((candidate) => candidate.harness === harness)
  // The harness list is closed and every member has an adapter, so a missing one is a bug in the
  // registry rather than an answer.
  if (adapter === undefined) throw new Error(`no adapter for ${harness}`)
  return adapter
}

function nativeTierRead(adapter: Adapter, tier: Tier): NativeTierRead {
  const reads: NativePathRead[] = []
  const declarations: NativeDeclaration[] = []
  for (const category of adapter.claimedCategories) {
    const read = handlerFor(adapter, category).read(tier)
    reads.push({
      category,
      paths: declaredPaths(tier, category),
      health: read.health,
      detail: read.detail,
    })
    for (const declaration of read.declarations) declarations.push(nativeDeclaration(declaration))
  }
  return { tier: tier.id, label: tier.nativeLabel, reads, declarations }
}

// `registry.ts` refuses an adapter that claims a category with no reader, so a claim is also the
// promise this loop reads by; the guard is the type system's half of that one agreement.
function handlerFor(adapter: Adapter, category: Category): CategoryHandler {
  const handler = adapter.handlers[category]
  if (handler === undefined) throw new Error(`${adapter.harness} claims ${category} with no reader`)
  return handler
}

function nativeDeclaration(declaration: DiscoveredDeclaration): NativeDeclaration {
  return {
    category: declaration.category,
    name: declaration.name,
    file: declaration.nativeFile,
    pointer: declaration.nativePointer,
    fields: fieldsOf(declaration.factsJson),
  }
}

// The reader built this string with `JSON.stringify` over values the classifier already cleared, so
// it parses back to a value an agent can read without a second decode. A string that does not is
// answered as absent instead of thrown, because an error message is where a fragment of the file
// would otherwise escape.
function fieldsOf(factsJson: string): NativeValue {
  try {
    const parsed = nativeValueSchema.safeParse(JSON.parse(factsJson))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
