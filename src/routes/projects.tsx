import { createFileRoute } from '@tanstack/react-router'
import { getDashboardData } from '../server/dashboard.functions'
import { ProjectsTable } from '../components/dashboard/ProjectsTable'

export const Route = createFileRoute('/projects')({
  loader: () => getDashboardData(),
  component: Projects,
})

function Projects() {
  const { local } = Route.useLoaderData()

  if (!local) {
    return (
      <>
        <h1>Project scope</h1>
        <div className="meta">database/local.json not found. Run: node scan.cjs</div>
      </>
    )
  }

  return <ProjectsTable projects={local.projects} />
}
