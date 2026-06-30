/**
 * JSON block renderer: pretty-print a JSON string.
 *
 * Used for two cases (driven by the registry):
 *   - whole-message detection: AI/user replied with a raw JSON document
 *   - fenced ```json code block inside markdown
 *
 * If the content fails to parse, fall back to a plain <pre> of the raw text
 * so the user still sees something useful instead of a blank.
 */
import { useMemo } from 'react'

/** Detect whether a whole message is a JSON document. */
export function isJson(content: string): boolean {
  const s = content.trim()
  if (!s.startsWith('{') && !s.startsWith('[')) return false
  try { JSON.parse(s); return true } catch { return false }
}

/** Escape HTML for safe injection into the colored <pre> markup. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Lightweight JSON token highlighter: wraps keys / strings / numbers /
 * booleans / null in <span> classes. Heavyweight libs (prismjs/shiki) are
 * intentionally avoided (YAGNI); this is enough for chat readability.
 */
function highlightJson(formatted: string): string {
  return escapeHtml(formatted)
    .replace(
      /("(?:\\.|[^"\\])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
      (match, _g, isKey) => {
        if (isKey) return `<span class="tok-key">${match}</span>`
        if (match === 'true' || match === 'false' || match === 'null')
          return `<span class="tok-bool">${match}</span>`
        if (match.startsWith('"')) return `<span class="tok-str">${match}</span>`
        return `<span class="tok-num">${match}</span>`
      },
    )
}

export default function JsonBlock({ content }: { content: string }) {
  const html = useMemo(() => {
    try {
      const parsed = JSON.parse(content)
      return highlightJson(JSON.stringify(parsed, null, 2))
    } catch {
      return escapeHtml(content)
    }
  }, [content])

  return (
    <pre
      className="as-codeblock json-block"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
