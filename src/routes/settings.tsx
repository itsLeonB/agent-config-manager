import { createFileRoute } from '@tanstack/react-router'
import { SettingsForm } from '../components/settings/SettingsForm'
import { getSettings } from '../server/settings.functions'

export const Route = createFileRoute('/settings')({
  loader: () => getSettings(),
  component: Settings,
})

function Settings() {
  return (
    <>
      <h1>Settings</h1>
      <div className="meta">
        Scan configuration. Values are read at the start of every scan, so a save takes effect on the next tick.
      </div>
      <SettingsForm settings={Route.useLoaderData()} />
    </>
  )
}
