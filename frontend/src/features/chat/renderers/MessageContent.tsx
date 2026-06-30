/**
 * Chat message content renderer.
 *
 * Pipeline:
 *   1. If the whole message matches a registered format (raw JSON / HTML),
 *      render it with that format's component.
 *   2. Otherwise render as markdown (react-markdown + remark-gfm). Fenced
 *      code blocks dispatch by language to the registry; unknown languages
 *      fall back to CodeBlock; inline code stays inline.
 *
 * react-markdown is safe by default (no rehype-raw): raw HTML in markdown is
 * escaped, never executed. HTML execution only happens via HtmlBlock, which
 * sanitizes with DOMPurify.
 */
import type { ComponentPropsWithoutRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { detectFormat, rendererByLang } from './registry'
import CodeBlock from './blocks/CodeBlock'

type CodeProps = ComponentPropsWithoutRef<'code'> & {
  className?: string
  children?: React.ReactNode
}

export default function MessageContent({ content }: { content: string }) {
  // 1) Whole-message format detection (pure JSON / pure HTML, no fences)
  const Whole = detectFormat(content)
  if (Whole) return <Whole content={content} />

  // 2) Markdown with per-language fenced-code dispatch
  return (
    <div className="as-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Let the `code` component own its <pre>; pass the outer <pre> through.
          pre: ({ children }) => <>{children}</>,
          code({ className, children, ...rest }: CodeProps) {
            const text = String(children ?? '').replace(/\n$/, '')
            const lang = /language-(\w+)/.exec(className || '')?.[1]
            const Renderer = lang ? rendererByLang.get(lang) : undefined
            if (Renderer) return <Renderer content={text} />
            if (text.includes('\n')) return <CodeBlock content={text} />
            return <code className={className} {...rest}>{children}</code>
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
