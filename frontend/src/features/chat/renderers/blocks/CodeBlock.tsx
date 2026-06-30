/**
 * Default fallback for fenced code blocks whose language has no registered
 * renderer (e.g. ```python). Themed <pre><code>, horizontally scrollable.
 * Syntax highlighting is intentionally out of scope for v1 (YAGNI); a future
 * highlight renderer can be added via the registry without touching this.
 */
export default function CodeBlock({ content }: { content: string }) {
  return (
    <pre className="as-codeblock">
      <code>{content}</code>
    </pre>
  )
}
