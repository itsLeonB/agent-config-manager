import type { Plugin, Skill, UserScope } from '../../types/dashboard'

function SkillsDropdown({ name, skills }: { name: string; skills: Skill[] }) {
  if (!skills.length) return <>{name}</>
  return (
    <details>
      <summary>
        {name} <span className="muted">({skills.length} skills)</span>
      </summary>
      <ul style={{ margin: '4px 0 0 16px' }}>
        {skills.map((s) => (
          <li key={s.name}>
            {s.name}
            {s.description ? <span className="muted"> — {s.description}</span> : null}
          </li>
        ))}
      </ul>
    </details>
  )
}

function groupByMarketplace<T>(items: T[], marketplaceOf: (item: T) => string) {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const key = marketplaceOf(item)
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(item)
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b))
}

export function PluginsTable({ userScope }: { userScope: UserScope }) {
  const skillsByUserPlugin = new Map<string, Skill[]>()
  for (const s of userScope.skills) {
    if (s.source !== 'plugin') continue
    const key = `${s.plugin}@${s.marketplace}`
    if (!skillsByUserPlugin.has(key)) skillsByUserPlugin.set(key, [])
    skillsByUserPlugin.get(key)!.push(s)
  }

  const groups = groupByMarketplace(userScope.plugins, (p) => p.marketplace)

  return (
    <>
      <h2>
        Plugins <span className="count">({userScope.plugins.length})</span>
      </h2>
      <table>
        <thead>
          <tr>
            <th>Plugin</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {groups.length === 0 && (
            <tr>
              <td className="muted" colSpan={2}>none</td>
            </tr>
          )}
          {groups.map(([marketplace, plugins]) => (
            <PluginGroup
              key={marketplace}
              marketplace={marketplace}
              plugins={plugins}
              skillsByUserPlugin={skillsByUserPlugin}
            />
          ))}
        </tbody>
      </table>
    </>
  )
}

function PluginGroup({
  marketplace,
  plugins,
  skillsByUserPlugin,
}: {
  marketplace: string
  plugins: Plugin[]
  skillsByUserPlugin: Map<string, Skill[]>
}) {
  return (
    <>
      <tr className="group-row">
        <td colSpan={2}>
          {marketplace} <span className="muted">({plugins.length})</span>
        </td>
      </tr>
      {plugins.map((p) => {
        const skills = skillsByUserPlugin.get(`${p.plugin}@${p.marketplace}`) || []
        return (
          <tr key={`${p.plugin}@${p.marketplace}`}>
            <td>
              <SkillsDropdown name={p.plugin} skills={skills} />
            </td>
            <td>
              <span className={`badge ${p.enabled ? 'on' : ''}`}>{p.enabled ? 'enabled' : 'disabled'}</span>{' '}
              <span className="muted">{p.version || ''}</span>
            </td>
          </tr>
        )
      })}
    </>
  )
}
