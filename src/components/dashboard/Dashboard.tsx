import type { DashboardData } from '../../types/dashboard'
import { EmptyState } from './EmptyState'
import { RescanButton } from './RescanButton'
import { PluginsTable } from './PluginsTable'
import { McpList } from './McpList'
import { SkillsTable } from './SkillsTable'
import { EnvironmentTools } from './EnvironmentTools'

export function Dashboard({ local }: DashboardData) {
  if (!local) {
    return (
      <>
        <EmptyState title="Agent Config Manager" />
        <RescanButton />
      </>
    )
  }

  return (
    <>
      <h1>Agent Config Manager</h1>
      <div className="meta">Generated {local.generatedAt}</div>
      <RescanButton />

      <section>
        <PluginsTable userScope={local.userScope} />
      </section>

      <section>
        <McpList userScope={local.userScope} />
      </section>

      <section>
        <SkillsTable userScope={local.userScope} />
      </section>

      <section>
        <EnvironmentTools tools={local.environmentTools} npx={local.npxSkillsGlobal} />
      </section>
    </>
  )
}
