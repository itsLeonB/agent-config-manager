import { useState } from 'react'
import type { Project } from '../../types/dashboard'

export function ProjectsTable({ projects }: { projects: Project[] }) {
  const [filter, setFilter] = useState('')
  const query = filter.trim().toLowerCase()

  return (
    <>
      <h2>
        Project scope <span className="count">({projects.length})</span>
      </h2>
      <input
        id="filter"
        type="text"
        placeholder="Filter projects by name…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <table id="projects-table">
        <thead>
          <tr>
            <th>Project</th>
            <th>Path</th>
            <th>Docs</th>
            <th>MCP</th>
            <th>Plugins</th>
            <th>Skills</th>
          </tr>
        </thead>
        <tbody id="projects-body">
          {projects.length === 0 ? (
            <tr>
              <td className="muted">none</td>
            </tr>
          ) : (
            projects.map((p) => {
              const skillCount = (p.skills?.length || 0) + (p.agentsSkills?.length || 0)
              const unlinked = (p.agentsSkills || []).filter((s) => !s.linkedIntoClaudeSkills).length
              const hidden = query && !p.name.toLowerCase().includes(query)
              return (
                <tr key={p.path} className={hidden ? 'hidden' : ''}>
                  <td>{p.name}</td>
                  <td className="muted">{p.path}</td>
                  <td>{p.docsFile ? <span className="badge">{p.docsFile}</span> : null}</td>
                  <td>{p.mcpJson ? <span className="badge on">.mcp.json</span> : null}</td>
                  <td>{p.pluginInstalls?.length ? <span className="badge on">{p.pluginInstalls.length} plugin(s)</span> : null}</td>
                  <td>
                    {skillCount || ''}
                    {unlinked ? <span className="badge"> {unlinked} unlinked</span> : null}
                  </td>
                </tr>
              )
            })
          )}
        </tbody>
      </table>
    </>
  )
}
