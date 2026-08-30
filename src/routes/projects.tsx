import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { getDashboardData } from '../server/dashboard.functions'
import { ProjectsTable } from '../components/dashboard/ProjectsTable'
import { ProjectsCompare } from '../components/dashboard/ProjectsCompare'

export const Route = createFileRoute('/projects')({
  loader: () => getDashboardData(),
  component: Projects,
})

function Projects() {
  const { local } = Route.useLoaderData()
  const [mode, setMode] = useState<'table' | 'compare'>('table')

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
        <button className={mode === 'table' ? 'active' : ''} onClick={() => setMode('table')}>
          Table
        </button>
        <button className={mode === 'compare' ? 'active' : ''} onClick={() => setMode('compare')}>
          Compare
        </button>
      </div>
      {mode === 'table' ? <ProjectsTable projects={local.projects} /> : <ProjectsCompare projects={local.projects} />}
    </>
  )
}
