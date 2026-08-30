export interface InstallGroup {
  heading: string
  commands: string[]
}

// Builds a pasteable script from a list of { heading, commands } groups:
// one `# <heading>` comment per group, followed by that group's commands
// (one comment covers all of a group's commands, not one per command).
export function buildInstallScript(groups: InstallGroup[]) {
  return groups
    .filter((g) => g.commands.length)
    .map((g) => `# ${g.heading}\n${g.commands.join('\n')}`)
    .join('\n\n')
}
