import type { DashboardData } from '../../types/dashboard'
import { CloudBanner } from './CloudBanner'
import { PluginsCompare } from './PluginsCompare'
import { McpList } from './McpList'
import { SkillsCompare } from './SkillsCompare'
import { EnvironmentTools } from './EnvironmentTools'
import { ProjectsTable } from './ProjectsTable'

export function Dashboard({ local, cloud }: DashboardData) {
  if (!local) {
    return (
      <>
        <h1>Agent Config Manager</h1>
        <div className="meta">database/local.json not found. Run: node scan.cjs</div>
      </>
    )
  }

  return (
    <>
      <h1>Agent Config Manager</h1>
      <div className="meta">Generated {local.generatedAt}</div>
      <CloudBanner cloud={cloud} />

      <section>
        <PluginsCompare userScope={local.userScope} cloud={cloud} />
      </section>

      <section>
        <McpList userScope={local.userScope} />
      </section>

      <section>
        <SkillsCompare userScope={local.userScope} cloud={cloud} />
      </section>

      <section>
        <EnvironmentTools tools={local.environmentTools} npx={local.npxSkillsGlobal} />
      </section>

      <section>
        <ProjectsTable projects={local.projects} />
      </section>
    </>
  )
}
