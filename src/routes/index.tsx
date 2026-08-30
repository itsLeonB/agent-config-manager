import { createFileRoute } from '@tanstack/react-router'
import { getDashboardData } from '../server/dashboard.functions'
import { Dashboard } from '../components/dashboard/Dashboard'

export const Route = createFileRoute('/')({
  loader: () => getDashboardData(),
  component: Index,
})

function Index() {
  const data = Route.useLoaderData()
  return <Dashboard local={data.local} cloud={data.cloud} />
}
