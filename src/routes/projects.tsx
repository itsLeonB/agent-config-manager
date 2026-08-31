import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { z } from 'zod'
import { getDashboardData } from '../server/dashboard.functions'
import { ProjectsTable } from '../components/dashboard/ProjectsTable'
import { ProjectsCompare } from '../components/dashboard/ProjectsCompare'

const projectsSearchSchema = z.object({
  mode: z.literal('compare').optional().catch(undefined),
  lhs: z.string().optional().catch(undefined),
  rhs: z.string().optional().catch(undefined),
})

export const Route = createFileRoute('/projects')({
  validateSearch: projectsSearchSchema,
  loader: () => getDashboardData(),
  component: Projects,
})

function Projects() {
  const { local } = Route.useLoaderData()
  const { mode = 'table' } = Route.useSearch()
  const navigate = useNavigate({ from: '/projects' })

  if (!local) {
    return (
      <>
        <h1>Project scope</h1>
        <div className="meta">database/local.json not found. Run: node scan.cjs</div>
      </>
    )
  }

  return (
    <>
      <div className="mode-toggle">
        <button
          className={mode === 'table' ? 'active' : ''}
          onClick={() => navigate({ search: (prev) => ({ ...prev, mode: undefined }) })}
        >
          Table
        </button>
        <button
          className={mode === 'compare' ? 'active' : ''}
          onClick={() => navigate({ search: (prev) => ({ ...prev, mode: 'compare' }) })}
        >
          Compare
        </button>
      </div>
      {mode === 'table' ? <ProjectsTable projects={local.projects} /> : <ProjectsCompare projects={local.projects} />}
    </>
  )
}
