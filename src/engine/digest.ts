import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import type { Stats } from 'node:fs'

export function digestOfBytes(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

// One digest for any path a plan names: a file's bytes, or a directory as its sorted relative
// listing with each file's own digest — so two copies of a skill are equal exactly when this is. A
// path that is not there has no digest, which is how a plan says "nothing to compare yet"; an
// unreadable one is the same answer, because a digest this process cannot compute proves nothing.
export function digestOfPath(file: string): string | null {
  const stats = statOf(file)
  if (stats === null) return null
  if (stats.isFile()) return digestOfFile(file)
  if (!stats.isDirectory()) return null
  try {
    const lines = relativeFiles(file).map((relative) => {
      const digest = digestOfFile(path.join(file, relative)) ?? 'unreadable'
      return `${relative}\0${digest}\n`
    })
    return digestOfBytes(Buffer.from(lines.join('')))
  } catch {
    return null
  }
}

// Every regular file under a directory, by relative path, sorted. A symlink counts as what it points
// at, because that is what a harness reading the directory sees.
export function relativeFiles(dir: string): string[] {
  const files: string[] = []
  walk(dir, '', files, new Set(), 0)
  return files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

// shortcut: a loop is cut by the resolved-directory set, and a tree deeper than 8 levels is left
// undescribed rather than walked forever; a real skill is a handful of levels.
function walk(dir: string, prefix: string, files: string[], seen: Set<string>, depth: number): void {
  if (depth > 8) return
  const real = realpathOf(dir)
  if (real === null || seen.has(real)) return
  seen.add(real)
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )
  for (const entry of entries) {
    const child = path.join(dir, entry.name)
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    const stats = statOf(child)
    if (stats === null) continue
    if (stats.isDirectory()) {
      walk(child, relative, files, seen, depth + 1)
      continue
    }
    if (stats.isFile()) files.push(relative)
  }
}

function realpathOf(dir: string): string | null {
  try {
    return realpathSync(dir)
  } catch {
    return null
  }
}

function statOf(file: string): Stats | null {
  try {
    // `statSync` follows a link on purpose: the bytes a harness loads are the target's.
    return statSync(file)
  } catch {
    return null
  }
}

function digestOfFile(file: string): string | null {
  try {
    return digestOfBytes(readFileSync(file))
  } catch {
    return null
  }
}
