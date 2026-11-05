import type { UserScope } from '../../types/dashboard'

export function SkillsTable({ userScope }: { userScope: UserScope }) {
  const userSkills = userScope.skills.filter((s) => s.source === 'standalone')

  return (
    <>
      <h2>
        Skills (standalone) <span className="count">({userSkills.length})</span>
      </h2>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          {userSkills.length === 0 ? (
            <tr>
              <td className="muted" colSpan={2}>none</td>
            </tr>
          ) : (
            userSkills.map((s) => (
              <tr key={s.name}>
                <td>{s.name}</td>
                <td className="muted">{s.description || ''}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </>
  )
}
