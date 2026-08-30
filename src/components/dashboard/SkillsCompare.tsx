import type { CloudData, UserScope } from '../../types/dashboard'
import { MissingCell } from './MissingCell'

export function SkillsCompare({ userScope, cloud }: { userScope: UserScope; cloud: CloudData | null }) {
  const cloudLoaded = !!cloud
  const userSkills = userScope.skills.filter((s) => s.source === 'standalone')
  const cloudSkills = (cloud?.skills || []).filter((s) => !s.marketplace)
  const cloudByName = new Map(cloudSkills.map((s) => [s.name.toLowerCase(), s]))
  const matched = new Set<string>()

  for (const s of userSkills) {
    if (cloudByName.has(s.name.toLowerCase())) matched.add(s.name.toLowerCase())
  }
  const cloudOnly = cloudSkills.filter((s) => !matched.has(s.name.toLowerCase()))

  return (
    <>
      <h2>
        Skills (standalone){' '}
        <span className="count">
          ({userSkills.length} user, {cloudSkills.length} cloud)
        </span>
      </h2>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th className="col-user">User scope</th>
            <th className="col-cloud">Cloud</th>
          </tr>
        </thead>
        <tbody>
          {userSkills.length === 0 && cloudOnly.length === 0 && (
            <tr>
              <td className="muted">none</td>
            </tr>
          )}
          {userSkills.map((s) => {
            const key = s.name.toLowerCase()
            const cloudMatch = cloudByName.get(key)
            return (
              <tr key={s.name}>
                <td>{s.name}</td>
                <td className="col-user muted">{s.description || ''}</td>
                {cloudMatch ? (
                  <td className="col-cloud muted">{cloudMatch.description || ''}</td>
                ) : (
                  <MissingCell
                    category="skills"
                    id={key}
                    placeholder="Why missing from cloud?"
                    cloudLoaded={cloudLoaded}
                    extraClass="col-cloud"
                  />
                )}
              </tr>
            )
          })}
          {cloudOnly.map((s) => (
            <tr key={s.name}>
              <td>{s.name}</td>
              <MissingCell
                category="skills"
                id={`cloud-only:${s.name.toLowerCase()}`}
                placeholder="Why missing from user scope?"
                cloudLoaded={true}
                extraClass="col-user"
              />
              <td className="col-cloud muted">{s.description || ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
