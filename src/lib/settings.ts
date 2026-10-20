import { z } from 'zod'

export type SettingsField = 'projectsRoot' | 'scanIntervalMinutes' | 'skipPaths' | 'environmentTools'

export interface FieldError {
  field: SettingsField
  message: string
  // The environment-tools row the error belongs to, so the summary can link to that row
  // instead of the whole area. Absent on errors from the server and from other fields.
  toolIndex?: number
}

const absolutePath = (value: string) => value.startsWith('/')

const toolSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'Tool name must start with a letter or digit.'),
  name: z.string().min(1, 'Tool name is required.'),
  // Runs as a shell command on every scan, so it is required and never hidden.
  checkCommand: z.string().min(1, 'Check command is required.'),
  installCommand: z.string().min(1, 'Install command is required.'),
})

export const projectsRootSchema = z
  .string()
  .min(1, 'Projects root is required.')
  .refine(absolutePath, 'Use an absolute path starting with /.')

export const scanIntervalSchema = z
  .number({ error: 'Use a whole number of minutes.' })
  .min(1, 'Use at least 1 minute.')
  .max(1440, 'Use at most 1440 minutes.')
  .refine(Number.isInteger, 'Use a whole number of minutes.')

export const skipPathsSchema = z.array(
  z
    .string()
    .min(1, 'Path is required.')
    .refine(absolutePath, 'Use an absolute path starting with /.'),
)

export const environmentToolsSchema = z.array(toolSchema).superRefine((tools, context) => {
  const seen = new Set<string>()
  for (const [index, tool] of tools.entries()) {
    if (seen.has(tool.id)) {
      context.addIssue({ code: 'custom', path: [index, 'name'], message: 'Two tools have the same name.' })
    }
    seen.add(tool.id)
  }
})

export const settingsSchema = z.object({
  projectsRoot: projectsRootSchema,
  scanIntervalMinutes: scanIntervalSchema,
  skipPaths: skipPathsSchema,
  environmentTools: environmentToolsSchema,
})

export type Settings = z.infer<typeof settingsSchema>

// The form holds raw text; this is what the user is typing, before validation.
export interface ToolDraft {
  // Identity of the row itself, which is not the stored tool id: that one still follows the
  // name, so it changes while the name is being typed and cannot key a React list.
  rowKey: string
  name: string
  checkCommand: string
  installCommand: string
}

export interface SettingsDraft {
  projectsRoot: string
  scanIntervalMinutes: string
  skipPaths: string
  tools: ToolDraft[]
}

export function toDraft(settings: Settings): SettingsDraft {
  return {
    projectsRoot: settings.projectsRoot,
    scanIntervalMinutes: String(settings.scanIntervalMinutes),
    skipPaths: settings.skipPaths.join('\n'),
    tools: settings.environmentTools.map(({ id, name, checkCommand, installCommand }) => ({
      rowKey: id,
      name,
      checkCommand,
      installCommand,
    })),
  }
}

// The tool id is not a field in the UI; it follows the name so the list stays
// readable in the store and a rename renames the id with it.
function toolId(name: string, index: number): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug === '' ? `tool-${index + 1}` : slug
}

export function draftToSettings(draft: SettingsDraft): Settings {
  const interval = draft.scanIntervalMinutes.trim()
  return {
    projectsRoot: draft.projectsRoot.trim(),
    scanIntervalMinutes: interval === '' ? Number.NaN : Number(interval),
    skipPaths: draft.skipPaths
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== ''),
    environmentTools: draft.tools.map((tool, index) => ({
      id: toolId(tool.name, index),
      name: tool.name.trim(),
      checkCommand: tool.checkCommand.trim(),
      installCommand: tool.installCommand.trim(),
    })),
  }
}

function fieldForPath(path: readonly PropertyKey[]): SettingsField {
  const head = path[0]
  return head === 'scanIntervalMinutes' || head === 'skipPaths' || head === 'environmentTools' ? head : 'projectsRoot'
}

export function isSettingsField(value: string): value is SettingsField {
  return value === 'projectsRoot' || value === 'scanIntervalMinutes' || value === 'skipPaths' || value === 'environmentTools'
}

// One validator for both blur and submit: a field shows the errors whose field matches.
export function validateDraft(draft: SettingsDraft): FieldError[] {
  const parsed = settingsSchema.safeParse(draftToSettings(draft))
  if (parsed.success) return []
  return parsed.error.issues.map((issue) => {
    const field = fieldForPath(issue.path)
    const toolIndex = field === 'environmentTools' ? Number(issue.path[1]) : Number.NaN
    if (!Number.isInteger(toolIndex)) return { field, message: issue.message }
    return { field, message: `Tool ${String(toolIndex + 1)}: ${issue.message}`, toolIndex }
  })
}
