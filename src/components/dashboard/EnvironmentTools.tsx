import { useState } from 'react'
import type { EnvironmentTool, NpxSkillsGlobal } from '../../types/dashboard'
import { buildInstallScript } from '../../lib/install-script'

export function EnvironmentTools({ tools, npx }: { tools: EnvironmentTool[]; npx: NpxSkillsGlobal }) {
  const [copyLabel, setCopyLabel] = useState('Copy install commands')
  const installedCount = tools.filter((t) => t.installedLocally).length

  const handleCopy = async () => {
    const script = buildInstallScript([
      ...tools.map((t) => ({ heading: t.name, commands: [t.installCommand] })),
      { heading: 'npx skills', commands: npx.skills.map((s) => s.installCommand).filter((c): c is string => !!c) },
    ])
    try {
      await navigator.clipboard.writeText(script)
      setCopyLabel('Copied!')
    } catch {
      setCopyLabel('Copy failed')
    }
    setTimeout(() => setCopyLabel('Copy install commands'), 1500)
  }

  return (
    <>
      <div className="section-header">
        <h2>
          Environment tools <span className="count">({installedCount}/{tools.length} installed locally)</span>
        </h2>
        <button id="copy-env-tools" className="copy-btn" onClick={handleCopy}>
          {copyLabel}
        </button>
      </div>
      <table>
        <thead>
          <tr>
            <th>Tool</th>
            <th>Local</th>
            <th>Cloud install command</th>
          </tr>
        </thead>
        <tbody>
          {tools.length === 0 ? (
            <tr>
              <td className="muted">none</td>
            </tr>
          ) : (
            tools.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td>{t.installedLocally ? <span className="check-yes">✓</span> : <span className="check-no">—</span>}</td>
                <td>
                  <pre className="install-cmd">{t.installCommand}</pre>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      <h3 style={{ marginTop: 20 }}>
        npx skills (global, vercel-labs/skills) <span className="count">({npx.skills.length})</span>
      </h3>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Source</th>
            <th>Claude Code</th>
            <th>Updated</th>
            <th>Cloud install command</th>
          </tr>
        </thead>
        <tbody>
          {npx.skills.length === 0 ? (
            <tr>
              <td className="muted">none</td>
            </tr>
          ) : (
            npx.skills.map((s) => (
              <tr key={s.name}>
                <td>{s.name}</td>
                <td className="muted">{s.source || ''}</td>
                <td>
                  <span className={`badge ${s.linkedToClaudeUserSkills ? 'on' : ''}`}>
                    {s.linkedToClaudeUserSkills ? 'linked' : 'not linked'}
                  </span>
                </td>
                <td className="muted">{s.updatedAt || s.installedAt || ''}</td>
                <td>
                  {s.installCommand ? <pre className="install-cmd">{s.installCommand}</pre> : <span className="muted">—</span>}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      {npx.lastSelectedAgents?.length ? (
        <p className="muted">Target agents: {npx.lastSelectedAgents.join(', ')}</p>
      ) : null}
    </>
  )
}
