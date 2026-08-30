// Comments explaining a missing counterpart are stored per-browser
// (localStorage) — there's no backend to write them back to a file.
export function commentKey(category: string, id: string) {
  return `agent-manager:comment:${category}:${id}`
}

export function loadComment(category: string, id: string) {
  try {
    return localStorage.getItem(commentKey(category, id)) || ''
  } catch {
    return ''
  }
}

export function saveComment(category: string, id: string, value: string) {
  try {
    localStorage.setItem(commentKey(category, id), value)
  } catch {
    // localStorage unavailable — comment just won't persist across reloads
  }
}
