import { useState } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import type { Project, ProjectNpxSkill, ProjectSkillEntry } from '../../types/dashboard'
import { buildInstallScript } from '../../lib/install-script'

interface CompareRow {
  key: string
  label: string
  left?: string
  right?: string
}

function buildRows<T>(
  left: T[],
  right: T[],
  keyOf: (item: T) => string,
  labelOf: (item: T) => string,
  valueOf: (item: T) => string,
): CompareRow[] {
  const byKey = new Map<string, CompareRow>()
  for (const item of left) {
    byKey.set(keyOf(item), { key: keyOf(item), label: labelOf(item), left: valueOf(item) })
  }
  for (const item of right) {
    const key = keyOf(item)
    const row = byKey.get(key) || { key, label: labelOf(item) }
    row.right = valueOf(item)
    byKey.set(key, row)
  }
  return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label))
}

function CompareTable({
  title,
  rows,
  leftName,
  rightName,
  renderMissing,
}: {
  title: string
  rows: CompareRow[]
  leftName: string
  rightName: string
  renderMissing?: (row: CompareRow, side: 'left' | 'right') => React.ReactNode
}) {
  return (
    <>
      <h3>
        {title} <span className="count">({rows.length})</span>
      </h3>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th className="col-user">{leftName}</th>
            <th className="col-cloud">{rightName}</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className="muted" colSpan={3}>none</td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.key}>
                <td>{r.label}</td>
                <td className="col-user">
                  {r.left ? (
                    <span className="muted">{r.left}</span>
                  ) : renderMissing ? (
                    renderMissing(r, 'left')
                  ) : (
                    <span className="badge missing-badge">missing</span>
                  )}
                </td>
                <td className="col-cloud">
                  {r.right ? (
                    <span className="muted">{r.right}</span>
                  ) : renderMissing ? (
                    renderMissing(r, 'right')
                  ) : (
                    <span className="badge missing-badge">missing</span>
                  )}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </>
  )
}


// Project-scoped install: dropping `npx skills add`'s `-g` flag installs the
// canonical copy into `<project>/.agents/skills/<name>` and symlinks
// `.claude/skills/<name>` to it for Claude Code (confirmed against the
// vercel-labs/skills installer) — mirrors the `-g` global command built in
// scan.cjs's getNpxSkillsGlobal.
// `skill.source`/`skill.name` come from another project's skills-lock.json —
// untrusted input, since it belongs to whichever project is being compared,
// not necessarily one the user wrote. Allowlist both before they reach a
// shell command that gets copied to the clipboard, and single-quote them so
// even an allowlisted value can't be reinterpreted by the shell.
const SAFE_SOURCE_RE = /^[A-Za-z0-9._/-]+$/
const SAFE_NAME_RE = /^[A-Za-z0-9._-]+$/
const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`

function buildNpxInstallCommand(skill: ProjectNpxSkill): string | null {
  if (skill.sourceType !== 'github' || !skill.source) return null
  if (!SAFE_SOURCE_RE.test(skill.source) || !SAFE_NAME_RE.test(skill.name)) return null
  return `npx skills add ${shellQuote(skill.source)} --skill ${shellQuote(skill.name)} -a claude-code -y`
}

function NpxCopyButton({
  buttonLabel,
  heading,
  selected,
  sourceSkills,
}: {
  buttonLabel: string
  heading: string
  selected: Set<string>
  sourceSkills: ProjectNpxSkill[]
}) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle')

  const handleCopy = async () => {
    const commands = [...selected]
      .map((name) => sourceSkills.find((s) => s.name === name))
      .filter((s): s is ProjectNpxSkill => !!s)
      .map(buildNpxInstallCommand)
      .filter((c): c is string => !!c)
    const script = buildInstallScript([{ heading, commands }])
    try {
      await navigator.clipboard.writeText(script)
      setStatus('copied')
    } catch {
      setStatus('failed')
    }
    setTimeout(() => setStatus('idle'), 1500)
  }

  const text = status === 'copied' ? 'Copied!' : status === 'failed' ? 'Copy failed' : buttonLabel

  return (
    <button className="copy-btn" disabled={selected.size === 0} onClick={handleCopy}>
      {text} ({selected.size})
    </button>
  )
}

// Each side gets its own selection + button so a generated script only ever
// installs skills into one project, never a mix of both.
function NpxSkillsCompare({ left, right }: { left: Project; right: Project }) {
  const isNpxSkill = (name: string) =>
    left.npxSkills.some((s) => s.name === name) || right.npxSkills.some((s) => s.name === name)
  const leftNpxSkills = left.skills.filter((s) => isNpxSkill(s.name))
  const rightNpxSkills = right.skills.filter((s) => isNpxSkill(s.name))
  const skillValue = (s: ProjectSkillEntry) => (s.isSymlink ? 'linked' : 'standalone')
  const rows = buildRows(leftNpxSkills, rightNpxSkills, (s) => s.name, (s) => s.name, skillValue)
  const missingKeys = (side: 'left' | 'right') =>
    rows.filter((r) => (side === 'left' ? !r.left : !r.right)).map((r) => r.key)

  const [selectedForLeft, setSelectedForLeft] = useState<Set<string>>(new Set())
  const [selectedForRight, setSelectedForRight] = useState<Set<string>>(new Set())
  // Shift-click anchor: only moves on a plain click, so repeated shift-clicks
  // keep extending the range from the same starting row (Explorer/Gmail-style).
  const [anchor, setAnchor] = useState<{ side: 'left' | 'right'; key: string } | null>(null)

  const setChecked = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, name: string, checked: boolean) =>
    setter((prev) => {
      const next = new Set(prev)
      if (checked) next.add(name)
      else next.delete(name)
      return next
    })

  const setRangeChecked = (
    setter: React.Dispatch<React.SetStateAction<Set<string>>>,
    side: 'left' | 'right',
    fromKey: string,
    toKey: string,
    checked: boolean,
  ) => {
    const keys = missingKeys(side)
    const i = keys.indexOf(fromKey)
    const j = keys.indexOf(toKey)
    if (i === -1 || j === -1) return
    const [lo, hi] = i < j ? [i, j] : [j, i]
    setter((prev) => {
      const next = new Set(prev)
      for (const key of keys.slice(lo, hi + 1)) {
        if (checked) next.add(key)
        else next.delete(key)
      }
      return next
    })
  }

  const handleCheckboxClick = (side: 'left' | 'right', key: string, e: React.MouseEvent<HTMLInputElement>) => {
    const checked = (e.target as HTMLInputElement).checked
    const setter = side === 'left' ? setSelectedForLeft : setSelectedForRight
    if (e.shiftKey && anchor && anchor.side === side) {
      setRangeChecked(setter, side, anchor.key, key, checked)
    } else {
      setChecked(setter, key, checked)
      setAnchor({ side, key })
    }
  }

  const renderMissing = (row: CompareRow, side: 'left' | 'right') => {
    const selected = side === 'left' ? selectedForLeft : selectedForRight
    return (
      <label className="badge missing-badge">
        <input
          type="checkbox"
          checked={selected.has(row.key)}
          onChange={() => {}}
          onClick={(e) => handleCheckboxClick(side, row.key, e)}
        />{' '}
        missing
      </label>
    )
  }

  return (
    <section>
      <CompareTable title="npx skills" leftName={left.name} rightName={right.name} rows={rows} renderMissing={renderMissing} />
      <div className="compare-npx-actions">
        <NpxCopyButton
          buttonLabel={`Copy install commands for ${left.name}`}
          heading={`Install missing npx skills into ${left.name}`}
          selected={selectedForLeft}
          sourceSkills={right.npxSkills}
        />
        <NpxCopyButton
          buttonLabel={`Copy install commands for ${right.name}`}
          heading={`Install missing npx skills into ${right.name}`}
          selected={selectedForRight}
          sourceSkills={left.npxSkills}
        />
      </div>
    </section>
  )
}

function ProjectPicker({
  projects,
  value,
  onChange,
}: {
  projects: Project[]
  value: string
  onChange: (path: string) => void
}) {
  return (
    <select className="compare-picker" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Select project…</option>
      {projects.map((p) => (
        <option key={p.path} value={p.path}>
          {p.name}
        </option>
      ))}
    </select>
  )
}

export function ProjectsCompare({ projects }: { projects: Project[] }) {
  const { lhs, rhs } = useSearch({ from: '/projects' })
  const navigate = useNavigate({ from: '/projects' })

  const left = projects.find((p) => p.path === lhs)
  const right = projects.find((p) => p.path === rhs)

  return (
    <>
      <div className="compare-pickers">
        <ProjectPicker
          projects={projects}
          value={lhs ?? ''}
          onChange={(path) => navigate({ search: (prev) => ({ ...prev, lhs: path || undefined }) })}
        />
        <span className="muted">vs</span>
        <ProjectPicker
          projects={projects}
          value={rhs ?? ''}
          onChange={(path) => navigate({ search: (prev) => ({ ...prev, rhs: path || undefined }) })}
        />
      </div>

      {!left || !right ? (
        <p className="muted">Select two projects to compare plugins, MCP servers, and skills.</p>
      ) : (
        <>
          <h2>
            {left.name} <span className="count">vs</span> {right.name}
          </h2>
          <section>
            <CompareTable
              title="Plugins"
              leftName={left.name}
              rightName={right.name}
              rows={buildRows(
                left.pluginInstalls,
                right.pluginInstalls,
                (p) => `${p.plugin}@${p.marketplace}`,
                (p) => p.plugin,
                (p) => p.version || 'installed',
              )}
            />
          </section>
          <section>
            <CompareTable
              title="MCP servers"
              leftName={left.name}
              rightName={right.name}
              rows={buildRows(
                Object.entries(left.mcpJson?.mcpServers || {}),
                Object.entries(right.mcpJson?.mcpServers || {}),
                ([name]) => name,
                ([name]) => name,
                ([, cfg]) => cfg.type || cfg.command || cfg.url || 'stdio',
              )}
            />
          </section>
          {(() => {
            const isNpxSkill = (name: string) =>
              left.npxSkills.some((s) => s.name === name) || right.npxSkills.some((s) => s.name === name)
            const leftSkills = left.skills.filter((s) => !isNpxSkill(s.name))
            const rightSkills = right.skills.filter((s) => !isNpxSkill(s.name))
            const skillValue = (s: (typeof left.skills)[number]) => (s.isSymlink ? 'linked' : 'standalone')
            return (
              <section>
                <CompareTable
                  title="Skills"
                  leftName={left.name}
                  rightName={right.name}
                  rows={buildRows(leftSkills, rightSkills, (s) => s.name, (s) => s.name, skillValue)}
                />
              </section>
            )
          })()}
          <NpxSkillsCompare key={`${left.path}:${right.path}`} left={left} right={right} />
        </>
      )}
    </>
  )
}
