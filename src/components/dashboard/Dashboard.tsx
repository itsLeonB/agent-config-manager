import type { DashboardData } from '../../types/dashboard'
import { CloudBanner } from './CloudBanner'
import { EmptyState } from './EmptyState'
import { RescanButton } from './RescanButton'
import { PluginsCompare } from './PluginsCompare'
import { McpList } from './McpList'
import { SkillsCompare } from './SkillsCompare'
import { EnvironmentTools } from './EnvironmentTools'

export function Dashboard({ local, cloud, comments }: DashboardData) {
  if (!local) {
    return (
      <>
        <EmptyState title="Agent Config Manager" />
        <RescanButton />
        <CloudBanner cloud={cloud} />
      </>
    )
  }

  return (
    <>
      <h1>Agent Config Manager</h1>
      <div className="meta">Generated {local.generatedAt}</div>
      <RescanButton />
      <CloudBanner cloud={cloud} />

      <section>
        <PluginsCompare userScope={local.userScope} cloud={cloud} comments={comments} />
      </section>

      <section>
        <McpList userScope={local.userScope} />
      </section>

      <section>
        <SkillsCompare userScope={local.userScope} cloud={cloud} comments={comments} />
      </section>

      <section>
        <EnvironmentTools tools={local.environmentTools} npx={local.npxSkillsGlobal} />
      </section>
    </>
  )
}
