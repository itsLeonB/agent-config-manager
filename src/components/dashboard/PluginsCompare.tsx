import type { CloudData, Plugin, Skill, UserScope } from '../../types/dashboard'
import { MissingCell } from './MissingCell'

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

export function PluginsCompare({ userScope, cloud }: { userScope: UserScope; cloud: CloudData | null }) {
  const cloudLoaded = !!cloud
  const cloudPlugins = cloud?.plugins || []
  const cloudByMarketplace = new Map(cloudPlugins.map((p) => [p.marketplace, p]))
  const matchedMarketplaces = new Set<string>()

  const skillsByUserPlugin = new Map<string, Skill[]>()
  for (const s of userScope.skills) {
    if (s.source !== 'plugin') continue
    const key = `${s.plugin}@${s.marketplace}`
    if (!skillsByUserPlugin.has(key)) skillsByUserPlugin.set(key, [])
    skillsByUserPlugin.get(key)!.push(s)
  }

  const groups = groupByMarketplace(userScope.plugins, (p) => p.marketplace)

  for (const [marketplace] of groups) {
    if (cloudByMarketplace.has(marketplace)) matchedMarketplaces.add(marketplace)
  }
  const cloudOnly = cloudPlugins.filter((p) => !matchedMarketplaces.has(p.marketplace))

  return (
    <>
      <h2>
        Plugins{' '}
        <span className="count">
          ({userScope.plugins.length} user, {cloudPlugins.length} cloud)
        </span>
      </h2>
      <table>
        <thead>
          <tr>
            <th>Plugin</th>
            <th className="col-user">User scope</th>
            <th className="col-cloud">Cloud</th>
          </tr>
        </thead>
        <tbody>
          {groups.length === 0 && cloudOnly.length === 0 && (
            <tr>
              <td className="muted">none</td>
            </tr>
          )}
          {groups.map(([marketplace, plugins]) => {
            const cloudPlugin = cloudByMarketplace.get(marketplace)
            const groupMissing = !cloudPlugin

            return (
              <PluginGroup
                key={marketplace}
                marketplace={marketplace}
                plugins={plugins}
                cloudPlugin={cloudPlugin}
                groupMissing={groupMissing}
                cloudLoaded={cloudLoaded}
                skillsByUserPlugin={skillsByUserPlugin}
              />
            )
          })}
          {cloudOnly.length > 0 && (
            <>
              <tr className="group-row">
                <td>Cloud-only ({cloudOnly.length})</td>
                <MissingCell
                  category="plugins"
                  id="group:cloud-only"
                  placeholder="Why missing from user scope?"
                  cloudLoaded={true}
                  extraClass="col-user"
                />
                <td className="col-cloud" />
              </tr>
              {cloudOnly.map((p) => (
                <tr key={p.name}>
                  <td>{p.name}</td>
                  <td className="missing col-user">
                    <span className="badge missing-badge">missing</span>
                  </td>
                  <td className="col-cloud muted">{p.description || ''}</td>
                </tr>
              ))}
            </>
          )}
        </tbody>
      </table>
    </>
  )
}

function PluginGroup({
  marketplace,
  plugins,
  cloudPlugin,
  groupMissing,
  cloudLoaded,
  skillsByUserPlugin,
}: {
  marketplace: string
  plugins: Plugin[]
  cloudPlugin: { name: string; marketplace: string; description?: string } | undefined
  groupMissing: boolean
  cloudLoaded: boolean
  skillsByUserPlugin: Map<string, Skill[]>
}) {
  return (
    <>
      {groupMissing ? (
        <tr className="group-row">
          <td>
            {marketplace} <span className="muted">({plugins.length})</span>
          </td>
          <td className="col-user" />
          <MissingCell
            category="plugins"
            id={`group:${marketplace}`}
            placeholder="Why missing from cloud? e.g. all claude-plugins-official entries cannot be installed in cloud"
            cloudLoaded={cloudLoaded}
            extraClass="col-cloud"
          />
        </tr>
      ) : (
        <tr className="group-row">
          <td colSpan={3}>
            {marketplace} <span className="muted">({plugins.length})</span>
          </td>
        </tr>
      )}
      {plugins.map((p) => {
        const skills = skillsByUserPlugin.get(`${p.plugin}@${p.marketplace}`) || []
        return (
          <tr key={`${p.plugin}@${p.marketplace}`}>
            <td>
              <SkillsDropdown name={p.plugin} skills={skills} />
            </td>
            <td className="col-user">
              <span className={`badge ${p.enabled ? 'on' : ''}`}>{p.enabled ? 'enabled' : 'disabled'}</span>{' '}
              <span className="muted">{p.version || ''}</span>
            </td>
            {cloudPlugin ? (
              <td className="col-cloud muted">{cloudPlugin.description || ''}</td>
            ) : (
              <td className="missing col-cloud">
                <span className="badge missing-badge">missing</span>
              </td>
            )}
          </tr>
        )
      })}
    </>
  )
}
