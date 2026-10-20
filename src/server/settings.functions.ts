import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { isSettingsField, settingsSchema } from '../lib/settings'
import type { FieldError, Settings } from '../lib/settings'
import { isSameOriginMutationRequest } from './origin-guard'
import { readSettings, writeSettings } from './settings.server'

export interface SaveSettingsResult {
  ok: boolean
  // A field of null means the failure belongs to the save itself, not to one field.
  errors: { field: string | null; message: string }[]
}

export const getSettings = createServerFn({ method: 'GET' }).handler(async (): Promise<Settings> => readSettings())

export const saveSettings = createServerFn({ method: 'POST' })
  .validator(settingsSchema)
  .handler(async ({ data }): Promise<SaveSettingsResult> => {
    if (!isSameOriginMutationRequest(getRequest())) {
      return { ok: false, errors: [{ field: null, message: 'Rejected: request did not come from the dashboard.' }] }
    }
    writeSettings(data)
    return { ok: true, errors: [] }
  })

// Client-side validation runs first; this maps any server-side field rejection back
// onto the same fields so the error summary can link to them.
export function fieldErrorsOf(errors: SaveSettingsResult['errors']): FieldError[] {
  return errors.flatMap((error) =>
    error.field !== null && isSettingsField(error.field) ? [{ field: error.field, message: error.message }] : [],
  )
}
