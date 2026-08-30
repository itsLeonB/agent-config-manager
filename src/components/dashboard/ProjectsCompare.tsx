import { useNavigate, useSearch } from '@tanstack/react-router'
import type { Project } from '../../types/dashboard'

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

function CompareTable({ title, rows, leftName, rightName }: { title: string; rows: CompareRow[]; leftName: string; rightName: string }) {
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
                  {r.left ? <span className="muted">{r.left}</span> : <span className="badge missing-badge">missing</span>}
                </td>
                <td className="col-cloud">
                  {r.right ? <span className="muted">{r.right}</span> : <span className="badge missing-badge">missing</span>}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </>
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
            const isNpxSkill = (name: string) => left.npxSkills.includes(name) || right.npxSkills.includes(name)
            const leftSkills = left.skills.filter((s) => !isNpxSkill(s.name))
            const rightSkills = right.skills.filter((s) => !isNpxSkill(s.name))
            const leftNpxSkills = left.skills.filter((s) => isNpxSkill(s.name))
            const rightNpxSkills = right.skills.filter((s) => isNpxSkill(s.name))
            const skillValue = (s: (typeof left.skills)[number]) => (s.isSymlink ? 'linked' : 'standalone')
            return (
              <>
                <section>
                  <CompareTable
                    title="Skills"
                    leftName={left.name}
                    rightName={right.name}
                    rows={buildRows(leftSkills, rightSkills, (s) => s.name, (s) => s.name, skillValue)}
                  />
                </section>
                <section>
                  <CompareTable
                    title="npx skills"
                    leftName={left.name}
                    rightName={right.name}
                    rows={buildRows(leftNpxSkills, rightNpxSkills, (s) => s.name, (s) => s.name, skillValue)}
                  />
                </section>
              </>
            )
          })()}
        </>
      )}
    </>
  )
}
