import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { getDashboardData } from '../server/dashboard.functions'
import { ProjectsTable } from '../components/dashboard/ProjectsTable'
import { ProjectsCompare } from '../components/dashboard/ProjectsCompare'

interface ProjectsSearch {
  mode?: 'table' | 'compare'
  lhs?: string
  rhs?: string
}

export const Route = createFileRoute('/projects')({
  validateSearch: (search: Record<string, unknown>): ProjectsSearch => ({
    mode: search.mode === 'compare' ? 'compare' : undefined,
    lhs: typeof search.lhs === 'string' ? search.lhs : undefined,
    rhs: typeof search.rhs === 'string' ? search.rhs : undefined,
  }),
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
