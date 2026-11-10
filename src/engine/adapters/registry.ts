import type { EngineConfig } from '../config.ts'
import { createCodexAdapter } from './codex/index.ts'
import { createOpenCodeAdapter } from './opencode/index.ts'
import { createPiAdapter } from './pi/index.ts'
import type { Adapter } from './types.ts'

export function createAdapters(config: EngineConfig): Adapter[] {
  const adapters = [createPiAdapter(config), createCodexAdapter(config), createOpenCodeAdapter(config)]
  for (const adapter of adapters) assertAgreement(adapter)
  return adapters
}

// The claimed categories and the handlers are two halves of one claim: a category declared without
// a handler would report as supported and then fail when read, so it fails while loading instead.
export function assertAgreement(adapter: Adapter): void {
  for (const category of adapter.claimedCategories) {
    if (adapter.handlers[category] === undefined) {
      throw new Error(`${adapter.harness} claims ${category} with no handler`)
    }
  }
  for (const category of Object.keys(adapter.handlers)) {
    if (!adapter.claimedCategories.some((claimed) => claimed === category)) {
      throw new Error(`${adapter.harness} ships a ${category} handler it does not claim`)
    }
  }
}
