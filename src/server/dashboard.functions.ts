import { createServerFn } from '@tanstack/react-start'
import { readCloudData, readLocalData } from './dashboard.server'
import type { DashboardData } from '../types/dashboard'

export const getDashboardData = createServerFn({ method: 'GET' }).handler(
  async (): Promise<DashboardData> => {
    const [local, cloud] = await Promise.all([readLocalData(), readCloudData()])
    return { local, cloud }
  },
)
