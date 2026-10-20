import { useEffect, useRef } from 'react'
import { commentKey } from '../../lib/comments'
import { saveComment } from '../../server/dashboard.functions'

const SAVE_DELAY_MS = 400

// cloudLoaded=false means cloud.json hasn't been scraped yet — show "not
// scraped" rather than implying a confirmed absence with a red highlight.
export function MissingCell({
  category,
  id,
  placeholder,
  cloudLoaded,
  comments,
  extraClass = '',
}: {
  category: string
  id: string
  placeholder: string
  cloudLoaded: boolean
  comments: Record<string, string>
  extraClass?: string
}) {
  // Uncontrolled on purpose: the stored text is the initial value, and typing must not
  // fight a re-render. Writes are debounced so one edit is one save, not one per keystroke.
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pending = useRef<string | null>(null)

  // A debounced save would be dropped if the page navigated before the timer fired, so the
  // pending text is written when the input loses focus and when the cell goes away.
  function flush() {
    clearTimeout(timer.current)
    const text = pending.current
    pending.current = null
    if (text === null) return
    // A failed write puts the text back, so the next blur or edit retries it instead of
    // the edit disappearing with the input.
    saveComment({ data: { category, id, text } }).then(
      (result) => {
        if (!result.ok) pending.current = text
      },
      () => {
        pending.current = text
      },
    )
  }

  useEffect(() => flush, [])

  if (!cloudLoaded) {
    return <td className={`muted ${extraClass}`}>not scraped yet</td>
  }

  return (
    <td className={`missing ${extraClass}`}>
      <span className="badge missing-badge">missing</span>
      <input
        type="text"
        className="comment-input"
        placeholder={placeholder}
        defaultValue={comments[commentKey(category, id)] ?? ''}
        onChange={(e) => {
          pending.current = e.target.value
          clearTimeout(timer.current)
          timer.current = setTimeout(flush, SAVE_DELAY_MS)
        }}
        onBlur={flush}
      />
    </td>
  )
}
