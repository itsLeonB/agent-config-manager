import { isPayloadInstall, isSectionInstall } from './loader.ts'
import type { InstallCommand } from './types.ts'

// What a Payload runs as and what a Section write writes, the one spelling the preview prints and
// the Run records: the resolved paths, never the bytes the files held. A string command is its own
// spelling. Every word is quoted the way a shell reads it back, so an argument with a space or a
// quote still arrives as one argv word and the preview shows exactly what runs; a payload path and a
// plain argument keep their bare spelling.
function shellWord(word: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`
}

export function installCommand(install: InstallCommand): string {
  if (isSectionInstall(install)) return `write ${shellWord(install.file)} from ${shellWord(install.section)}`
  if (!isPayloadInstall(install)) return install
  return ['sh', install.payload, ...(install.args ?? [])].map(shellWord).join(' ')
}
