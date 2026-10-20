import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { draftToSettings, toDraft, validateDraft } from '../../lib/settings'
import type { FieldError, Settings, SettingsDraft, SettingsField, ToolDraft } from '../../lib/settings'
import { fieldErrorsOf, saveSettings } from '../../server/settings.functions'

type SaveStatus = 'idle' | 'saving' | 'saved'

const TOOLS_ERROR_ID = 'environmentTools-error'

// A stored tool's id keys its row; a row added in this session has no stored id yet, so it
// gets a key that cannot collide with one.
let addedRows = 0
function emptyTool(): ToolDraft {
  addedRows += 1
  return { rowKey: `added-${String(addedRows)}`, name: '', checkCommand: '', installCommand: '' }
}

const toolInputId = (index: number, field: keyof Omit<ToolDraft, 'rowKey'>) =>
  `tool-${String(index)}-${field}`

// Every summary link has to land on a real input, so the tools area points at the first
// invalid row instead of the section.
function anchorFor(error: FieldError): string {
  if (error.field !== 'environmentTools') return error.field
  return error.toolIndex === undefined ? 'environmentTools-add' : toolInputId(error.toolIndex, 'name')
}

export function SettingsForm({ settings }: { settings: Settings }) {
  const [draft, setDraft] = useState<SettingsDraft>(() => toDraft(settings))
  const [errors, setErrors] = useState<FieldError[]>([])
  const [saveError, setSaveError] = useState<string | null>(null)
  const [summary, setSummary] = useState(false)
  const [status, setStatus] = useState<SaveStatus>('idle')
  const [focusToken, setFocusToken] = useState(0)
  const summaryRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (focusToken > 0) summaryRef.current?.focus()
  }, [focusToken])

  const errorFor = (field: SettingsField) => errors.find((error) => error.field === field)?.message
  const toolsError = errors.find((error) => error.field === 'environmentTools')

  function edit(patch: Partial<SettingsDraft>) {
    setDraft((prev) => ({ ...prev, ...patch }))
    setStatus('idle')
  }

  function editTool(index: number, patch: Partial<ToolDraft>) {
    const tools = draft.tools.map((tool, position) => (position === index ? { ...tool, ...patch } : tool))
    edit({ tools })
  }

  // Validation on blur: only the field that just lost focus is judged, so typing
  // in one field never reddens another.
  function validateField(field: SettingsField) {
    const found = validateDraft(draft).filter((error) => error.field === field)
    setErrors((prev) => [...prev.filter((error) => error.field !== field), ...found])
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSaveError(null)
    const found = validateDraft(draft)
    setErrors(found)
    if (found.length > 0) {
      setStatus('idle')
      setSummary(true)
      setFocusToken((token) => token + 1)
      return
    }

    setStatus('saving')
    try {
      const result = await saveSettings({ data: draftToSettings(draft) })
      if (result.ok) {
        setSummary(false)
        setStatus('saved')
        return
      }
      setErrors(fieldErrorsOf(result.errors))
      setSaveError(result.errors.find((error) => error.field === null)?.message ?? null)
    } catch {
      setSaveError('Save failed: the server did not accept the request.')
    }
    setStatus('idle')
    setSummary(true)
    setFocusToken((token) => token + 1)
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      {summary ? (
        <div className="settings-summary" ref={summaryRef} tabIndex={-1} role="alert">
          <p>Settings were not saved. Fix these and save again:</p>
          <ul>
            {errors.map((error, index) => (
              <li key={`${error.field}-${index}`}>
                <a href={`#${anchorFor(error)}`}>{error.message}</a>
              </li>
            ))}
            {saveError !== null ? <li>{saveError}</li> : null}
          </ul>
        </div>
      ) : null}

      <section>
        <h2>Scan</h2>
        <div className="settings-field">
          <label htmlFor="projectsRoot">Projects root</label>
          <input
            id="projectsRoot"
            value={draft.projectsRoot}
            onChange={(event) => edit({ projectsRoot: event.target.value })}
            onBlur={() => validateField('projectsRoot')}
            aria-invalid={errorFor('projectsRoot') !== undefined}
            aria-describedby={errorFor('projectsRoot') !== undefined ? 'projectsRoot-error' : undefined}
          />
          {errorFor('projectsRoot') !== undefined ? (
            <p className="field-error" id="projectsRoot-error">
              {errorFor('projectsRoot')}
            </p>
          ) : null}
        </div>

        <div className="settings-field">
          <label htmlFor="scanIntervalMinutes">Scan interval (minutes)</label>
          <input
            id="scanIntervalMinutes"
            type="number"
            min={1}
            step={1}
            value={draft.scanIntervalMinutes}
            onChange={(event) => edit({ scanIntervalMinutes: event.target.value })}
            onBlur={() => validateField('scanIntervalMinutes')}
            aria-invalid={errorFor('scanIntervalMinutes') !== undefined}
            aria-describedby={errorFor('scanIntervalMinutes') !== undefined ? 'scanIntervalMinutes-error' : undefined}
          />
          {errorFor('scanIntervalMinutes') !== undefined ? (
            <p className="field-error" id="scanIntervalMinutes-error">
              {errorFor('scanIntervalMinutes')}
            </p>
          ) : null}
        </div>

        <div className="settings-field">
          <label htmlFor="skipPaths">Skip paths (one absolute path per line)</label>
          <textarea
            id="skipPaths"
            rows={4}
            value={draft.skipPaths}
            onChange={(event) => edit({ skipPaths: event.target.value })}
            onBlur={() => validateField('skipPaths')}
            aria-invalid={errorFor('skipPaths') !== undefined}
            aria-describedby={errorFor('skipPaths') !== undefined ? 'skipPaths-error' : undefined}
          />
          {errorFor('skipPaths') !== undefined ? (
            <p className="field-error" id="skipPaths-error">
              {errorFor('skipPaths')}
            </p>
          ) : null}
        </div>
      </section>

      <section id="environmentTools">
        <h2>
          Environment tools <span className="count">({draft.tools.length})</span>
        </h2>
        <p className="muted">
          The check command runs as a shell command on every scan, so only add commands you trust.
        </p>
        <table className="settings-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Check command</th>
              <th>Install command</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {draft.tools.length === 0 ? (
              <tr>
                <td className="muted">none</td>
              </tr>
            ) : (
              draft.tools.map((tool, index) => {
                const rowError = errors.find((error) => error.toolIndex === index)
                const describedBy = rowError === undefined ? undefined : TOOLS_ERROR_ID
                return (
                  <tr key={tool.rowKey}>
                    <td>
                      <input
                        id={toolInputId(index, 'name')}
                        aria-label={`Tool ${index + 1} name`}
                        value={tool.name}
                        onChange={(event) => editTool(index, { name: event.target.value })}
                        onBlur={() => validateField('environmentTools')}
                        aria-invalid={rowError !== undefined}
                        aria-describedby={describedBy}
                      />
                    </td>
                    <td>
                      <input
                        id={toolInputId(index, 'checkCommand')}
                        aria-label={`Tool ${index + 1} check command`}
                        value={tool.checkCommand}
                        onChange={(event) => editTool(index, { checkCommand: event.target.value })}
                        onBlur={() => validateField('environmentTools')}
                        aria-invalid={rowError !== undefined}
                        aria-describedby={describedBy}
                      />
                    </td>
                    <td>
                      <input
                        id={toolInputId(index, 'installCommand')}
                        aria-label={`Tool ${index + 1} install command`}
                        value={tool.installCommand}
                        onChange={(event) => editTool(index, { installCommand: event.target.value })}
                        onBlur={() => validateField('environmentTools')}
                        aria-invalid={rowError !== undefined}
                        aria-describedby={describedBy}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="copy-btn"
                        aria-label={`Remove ${tool.name === '' ? `tool ${index + 1}` : tool.name}`}
                        onClick={() => edit({ tools: draft.tools.filter((_, position) => position !== index) })}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
        {toolsError === undefined ? null : (
          <p className="field-error" id={TOOLS_ERROR_ID}>
            {toolsError.message}
          </p>
        )}
        <p>
          <button
            type="button"
            id="environmentTools-add"
            className="copy-btn"
            onClick={() => edit({ tools: [...draft.tools, emptyTool()] })}
          >
            Add tool
          </button>
        </p>
      </section>

      <div className="settings-actions">
        <button type="submit" className="settings-save" disabled={status === 'saving'}>
          {status === 'saving' ? 'Saving…' : 'Save settings'}
        </button>
        {status === 'saved' ? (
          <span className="settings-saved" role="status">
            Saved. The scanner uses these values on its next tick.
          </span>
        ) : null}
      </div>
    </form>
  )
}
