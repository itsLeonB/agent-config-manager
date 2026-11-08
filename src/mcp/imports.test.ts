import test from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The two faces reach the engine through `service.ts` and nothing deeper: a plan, a store row, or an
// adapter is an implementation detail of the library, and a face that imported one would be free to
// re-derive a plan, write a file, or read the store behind the service's back.
const FORBIDDEN = ['repo.ts', 'plan.ts', 'adapters']

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sources(full)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : []
  })
}

// Matched by path segment, not by suffix: `../engine/adapters/registry.ts` and the `#/…` alias are
// the same breach as `../engine/plan.ts`.
function forbidden(specifier: string): boolean {
  return specifier
    .split('/')
    .some((segment) => FORBIDDEN.includes(segment))
}

function importedFrom(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8')
  // Every spelling a face can reach a module by: a static import, a re-export, a `require`, and the
  // dynamic `import()` the CLI uses to load the MCP face.
  return [...text.matchAll(/(?:from|import\(|require\()\s*'([^']+)'/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  )
}

test('the CLI and MCP faces import the service and never the engine internals', () => {
  const faces = ['../cli', '../mcp'].map((face) => fileURLToPath(new URL(face, import.meta.url)))
  const offenders = faces
    .flatMap(sources)
    .flatMap((file) => importedFrom(file).map((specifier) => ({ file, specifier })))
    .filter(({ specifier }) => forbidden(specifier))
  assert.deepEqual(offenders, [])
})
