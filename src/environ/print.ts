// A Provision name, a Check's detail, and an Install command all come from a file, so control
// characters in them would forge or corrupt the line they are printed in. The status and the run
// print through this one function.
export function printable(value: string): string {
  // oxlint-disable-next-line no-control-regex -- stripping control characters is the point
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?')
}

// A count beside its noun, so a printed line says `1 entry` and `3 entries` without the caller
// spelling both.
export function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}
