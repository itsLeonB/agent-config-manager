import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

// The MCP face registers no tool yet: the environment tools land here, one at a time, as the tickets
// that own them arrive. Declaring the tools capability in the constructor is what makes `tools/list`
// answer an empty list instead of "method not found", and it leaves `registerTool` free to add them.
export function createRouter(): McpServer {
  return new McpServer(
    { name: 'agent-config-manager', version: '0.1.0' },
    { capabilities: { tools: {} } },
  )
}
