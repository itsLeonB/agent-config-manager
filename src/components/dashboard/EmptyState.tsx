// A store with no snapshot row: a fresh install, or a reset that deleted the file.
export function EmptyState({ title }: { title: string }) {
  return (
    <>
      <h1>{title}</h1>
      <div className="meta">
        No scan stored in database/dashboard.db yet. The scanner writes one when it
        starts, or press Rescan now.
      </div>
    </>
  )
}
