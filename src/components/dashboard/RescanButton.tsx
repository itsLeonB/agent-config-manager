import { useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { rescan } from '../../server/dashboard.functions'

// Re-runs the loader instead of patching state so the page renders exactly what the
// scanner wrote. A failed scan returns early, leaving the previous snapshot on screen.
export function RescanButton() {
  const router = useRouter()
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleClick() {
    setScanning(true)
    setError(null)
    try {
      const result = await rescan()
      if (result.ok) await router.invalidate()
      else setError(result.error)
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : 'Rescan request failed.')
    } finally {
      setScanning(false)
    }
  }

  return (
    <div className="rescan">
      <button type="button" className="rescan-btn" onClick={handleClick} disabled={scanning}>
        {scanning ? 'Scanning…' : 'Rescan now'}
      </button>
      {error !== null && <div className="banner rescan-error">{error}</div>}
    </div>
  )
}
