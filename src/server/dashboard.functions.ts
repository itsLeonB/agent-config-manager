import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { readCloudData, readLocalData, runScan } from './dashboard.server'
import { isSameOriginRequest } from './origin-guard'
import type { DashboardData, RescanResult } from '../types/dashboard'

export const getDashboardData = createServerFn({ method: 'GET' }).handler(
  async (): Promise<DashboardData> => {
    const [local, cloud] = await Promise.all([readLocalData(), readCloudData()])
    return { local, cloud }
  },
)

// Behind Dokploy the request reaches us as an internal host, so the proxy's forwarded
// host and protocol are accepted as this site's own origin too.
function allowedOrigins(request: Request): string[] {
  const url = new URL(request.url)
  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0].trim()
  const host = forwardedHost !== undefined && forwardedHost !== '' ? forwardedHost : request.headers.get('host')
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0].trim()
  const proto = forwardedProto !== undefined && forwardedProto !== '' ? forwardedProto : url.protocol.slice(0, -1)
  const origins = [url.origin]
  if (host !== null) origins.push(`${proto}://${host}`)
  return origins
}

export const rescan = createServerFn({ method: 'POST' }).handler(async (): Promise<RescanResult> => {
  const request = getRequest()
  const sameOrigin = isSameOriginRequest(
    request.headers.get('origin'),
    request.headers.get('sec-fetch-site'),
    allowedOrigins(request),
  )
  if (!sameOrigin) return { ok: false, error: 'Rejected: request did not come from the dashboard.' }
  return runScan()
})
