import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { z } from 'zod'
import { readCloudData, readComments, readLocalData, runScan, writeComment } from './dashboard.server'
import { isSameOriginMutationRequest } from './origin-guard'
import type { DashboardData, RescanResult } from '../types/dashboard'

export const getDashboardData = createServerFn({ method: 'GET' }).handler(
  async (): Promise<DashboardData> => {
    const [local, cloud] = await Promise.all([readLocalData(), readCloudData()])
    return { local, cloud, comments: readComments() }
  },
)

export const rescan = createServerFn({ method: 'POST' }).handler(async (): Promise<RescanResult> => {
  if (!isSameOriginMutationRequest(getRequest())) {
    return { ok: false, error: 'Rejected: request did not come from the dashboard.' }
  }
  return runScan()
})

const commentInput = z.object({
  category: z.string().min(1),
  id: z.string().min(1),
  text: z.string(),
})

export const saveComment = createServerFn({ method: 'POST' })
  .validator(commentInput)
  .handler(async ({ data }): Promise<{ ok: boolean }> => {
    if (!isSameOriginMutationRequest(getRequest())) return { ok: false }
    writeComment(data.category, data.id, data.text)
    return { ok: true }
  })
