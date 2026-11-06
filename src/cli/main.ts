#!/usr/bin/env bun
import { parseArgs } from 'node:util'
import { resolveDefaultConfig } from '../engine/config.ts'
import { discover, listInstallations } from '../engine/service.ts'
import type { InstallationRow } from '../server/store.cjs'

const USAGE = `usage: acm <command>

  list   report the inventory the store holds
         [--category <category>] [--harness <harness>] [--scope <scope>] [--all] [--json]
`

interface ListOptions {
  category?: string
  harness?: string
  scope?: string
  all: boolean
  json: boolean
}

function main(argv: string[]): number {
  const command = argv[0]
  const rest = argv.slice(1)
  if (command === 'list') return list(rest)
  process.stderr.write(USAGE)
  return 1
}

function list(argv: string[]): number {
  const options = parseListOptions(argv)
  if (options === null) {
    process.stderr.write(USAGE)
    return 1
  }
  const config = resolveDefaultConfig()
  // Discovery first, then a read of the store: what is printed is what was recorded, not a second
  // parse of the native files.
  const scan = discover(config)
  const inventory = listInstallations(config, {
    category: options.category,
    harness: options.harness,
    scope: options.scope,
    includeRemoved: options.all,
  })
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ scan, ...inventory }, null, 2)}\n`)
    return 0
  }
  for (const row of inventory.installations) {
    process.stdout.write(`${formatRow(row, config.home)}\n`)
  }
  const counted = `${inventory.installations.length} installation${inventory.installations.length === 1 ? '' : 's'}`
  process.stdout.write(`\n${counted} · scanned ${scan.scannedAt}\n`)
  for (const health of inventory.tierHealth) {
    if (health.status !== 'ok') {
      process.stdout.write(`unreadable tier ${health.tierId}: ${health.detail ?? 'unknown'}\n`)
    }
  }
  return 0
}

function parseListOptions(argv: string[]): ListOptions | null {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        category: { type: 'string' },
        harness: { type: 'string' },
        scope: { type: 'string' },
        all: { type: 'boolean' },
        json: { type: 'boolean' },
      },
    })
    return {
      category: values.category,
      harness: values.harness,
      scope: values.scope,
      all: values.all === true,
      json: values.json === true,
    }
  } catch {
    return null
  }
}

function formatRow(row: InstallationRow, home: string): string {
  const tiers = row.bindings.map((binding) => binding.tierId).join(',')
  const location = `${shorten(row.nativeFile, home)}#${row.nativePointer ?? ''}`
  const removed = row.removedAt === null ? '' : '  (removed)'
  return [row.category, row.name, row.scope, tiers, location, shortDigest(row.contentDigest)].join('  ') + removed
}

function shortDigest(digest: string | null): string {
  return digest === null ? '-' : `${digest.slice(0, 15)}…`
}

function shorten(file: string, home: string): string {
  return file.startsWith(home) ? `~${file.slice(home.length)}` : file
}

process.exitCode = main(process.argv.slice(2))
