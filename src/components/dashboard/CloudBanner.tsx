import type { CloudData } from '../../types/dashboard'

const CLOUD_STALE_MS = 7 * 24 * 60 * 60 * 1000

export function CloudBanner({ cloud }: { cloud: CloudData | null }) {
  if (!cloud) {
    return (
      <div className="banner">
        No cloud data yet. Ask Claude to run <code>/refresh-cloud</code> to
        scrape claude.ai.
      </div>
    )
  }

  const age = Date.now() - new Date(cloud.lastUpdated).getTime()
  if (age <= CLOUD_STALE_MS) return null

  return (
    <div className="banner">
      Cloud data is stale (last updated {cloud.lastUpdated}). Run{' '}
      <code>/refresh-cloud</code> to update.
    </div>
  )
}
