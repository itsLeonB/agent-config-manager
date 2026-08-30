export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

export interface Skill {
  name: string
  description?: string
  source?: 'plugin' | 'standalone'
  plugin?: string
  marketplace?: string
}

export interface Plugin {
  plugin: string
  marketplace: string
  enabled: boolean
  version?: string
}

export interface McpServerConfig {
  type?: string
  url?: string
  command?: string
}

export interface EnvironmentTool {
  id: string
  name: string
  installedLocally: boolean
  installCommand: string
}

export interface NpxSkill {
  name: string
  source?: string
  linkedToClaudeUserSkills: boolean
  updatedAt?: string
  installedAt?: string
  installCommand?: string
}

export interface NpxSkillsGlobal {
  skills: NpxSkill[]
  lastSelectedAgents: string[]
}

export interface Project {
  name: string
  path: string
  docsFile: string | null
  mcpJson: Json | null
  pluginInstalls: Json[]
  skills: Skill[]
  agentsSkills: { name: string; linkedIntoClaudeSkills: boolean }[]
}

export interface UserScope {
  plugins: Plugin[]
  mcpServers: Record<string, McpServerConfig>
  skills: Skill[]
}

export interface LocalData {
  generatedAt: string
  userScope: UserScope
  npxSkillsGlobal: NpxSkillsGlobal
  environmentTools: EnvironmentTool[]
  projects: Project[]
}

export interface CloudPlugin {
  name: string
  marketplace: string
  description?: string
}

export interface CloudSkill {
  name: string
  description?: string
  marketplace?: string
}

export interface CloudData {
  lastUpdated: string
  plugins: CloudPlugin[]
  skills: CloudSkill[]
}

export interface DashboardData {
  local: LocalData | null
  cloud: CloudData | null
}
