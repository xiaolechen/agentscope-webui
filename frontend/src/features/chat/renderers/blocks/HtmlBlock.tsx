/**
 * HTML block renderer: sanitize with DOMPurify, then render inline.
 *
 * DOMPurify strips <script>, on* event handlers, javascript: URIs, and other
 * XSS vectors before injection. The AI's/user's HTML renders inline within
 * the chat bubble, themed via `.as-html`.
 *
 * Used for: whole-message HTML detection AND fenced ```html code blocks.
 */
import DOMPurify from 'dompurify'

/** Detect whether a whole message is an HTML document. */
export function isHtml(content: string): boolean {
  const s = content.trim()
  // Starts with a tag (`<a`, `<!doctype`, `<!--`) and contains a closing `>`.
  // Avoids matching markdown that merely begins with `<` (rare, but safe default).
  return (/^<[a-zA-Z!]/.test(s) && s.includes('>'))
}

export default function HtmlBlock({ content }: { content: string }) {
  return (
    <div
      className="as-html"
      dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(content) }}
    />
  )
}
