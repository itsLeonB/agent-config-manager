import type { UserScope } from '../../types/dashboard'

// claude.ai connectors (Figma, Notion, Google Drive, ...) sync automatically
// into Claude Code's live MCP list (`claude mcp list`) — they're not written to
// ~/.claude.json, so they never appear here. This just lists what scan.cjs found
// locally.
export function McpList({ userScope }: { userScope: UserScope }) {
  const entries = Object.entries(userScope.mcpServers || {})

  return (
    <>
      <h2>
        MCP servers <span className="count">({entries.length})</span>
      </h2>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Command / URL</th>
          </tr>
        </thead>
        <tbody>
          {entries.length === 0 ? (
            <tr>
              <td className="muted" colSpan={3}>none</td>
            </tr>
          ) : (
            entries.map(([name, cfg]) => (
              <tr key={name}>
                <td>{name}</td>
                <td className="muted">{cfg.type || 'stdio'}</td>
                <td className="muted">{cfg.url || cfg.command || ''}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      <p className="muted">
        claude.ai connectors (Figma, Notion, Google Drive, etc.) sync automatically into Claude Code — check{' '}
        <code>claude mcp list</code> for the live set. Not duplicated here.
      </p>
    </>
  )
}
