import { useState } from 'react'
import { loadComment, saveComment } from '../../lib/comments'

// cloudLoaded=false means cloud.json hasn't been scraped yet — show "not
// scraped" rather than implying a confirmed absence with a red highlight.
export function MissingCell({
  category,
  id,
  placeholder,
  cloudLoaded,
  extraClass = '',
}: {
  category: string
  id: string
  placeholder: string
  cloudLoaded: boolean
  extraClass?: string
}) {
  const [value, setValue] = useState(() => loadComment(category, id))

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
        value={value}
        onChange={(e) => {
          setValue(e.target.value)
          saveComment(category, id, e.target.value)
        }}
      />
    </td>
  )
}
