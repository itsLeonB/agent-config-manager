import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { readCloudData, readLocalData, runScan } from './dashboard.server'
import { isSameOriginMutationRequest } from './origin-guard'
import type { DashboardData, RescanResult } from '../types/dashboard'

export const getDashboardData = createServerFn({ method: 'GET' }).handler(
  async (): Promise<DashboardData> => {
    const [local, cloud] = await Promise.all([readLocalData(), readCloudData()])
    return { local, cloud }
  },
)

export const rescan = createServerFn({ method: 'POST' }).handler(async (): Promise<RescanResult> => {
  if (!isSameOriginMutationRequest(getRequest())) {
    return { ok: false, error: 'Rejected: request did not come from the dashboard.' }
  }
  return runScan()
})
