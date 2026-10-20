import { useRef } from 'react'
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
          const text = e.target.value
          clearTimeout(timer.current)
          timer.current = setTimeout(() => void saveComment({ data: { category, id, text } }), SAVE_DELAY_MS)
        }}
      />
    </td>
  )
}
