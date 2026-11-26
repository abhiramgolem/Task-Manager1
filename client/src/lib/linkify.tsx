import React from 'react'

// Links in task text (title, description, comments) open the way they do in
// chat. Same matcher as the chat bubble's (Chats.tsx URL_RE), plus bare
// "www." addresses, which the chat info panel's link list already counts
// (ChatMedia.tsx): it stops at whitespace and leaves a full stop or comma after
// a link outside it. Only React nodes come out, never HTML, so task text can't
// be read as markup.
const LINK_RE = /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+[^\s<>"')\].,;:!?]/gi

export function Linkify({ text }: { text: string | null | undefined }) {
  if (!text) return null
  const out: React.ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  LINK_RE.lastIndex = 0
  while ((m = LINK_RE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const tok = m[0]
    const href = /^https?:\/\//i.test(tok) ? tok : `https://${tok}`
    // A link can sit inside something clickable (a comment row, the drawer's
    // hero): opening the link must not also trigger that.
    out.push(<a key={m.index} href={href} target="_blank" rel="noopener noreferrer" className="task-link" onClick={(e) => e.stopPropagation()}>{tok}</a>)
    last = m.index + tok.length
  }
  if (last === 0) return <>{text}</>
  if (last < text.length) out.push(text.slice(last))
  return <>{out}</>
}
