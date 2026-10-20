// A comment belongs to one item, scoped by category, so the key is also the
// store's primary key. Shared by the server function and the input that reads it.
export function commentKey(category: string, id: string) {
  return `${category}:${id}`
}
