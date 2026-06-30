/**
 * Open-closed renderer registry — single source of truth for chat content
 * format rendering.
 *
 * Each entry drives TWO dispatch paths:
 *   - whole-message detection: detectFormat(content) tries each `test`
 *   - fenced-code-language dispatch: rendererByLang.get(language)
 *
 * Adding a new format (e.g. CSV):
 *   1. create blocks/CsvBlock.tsx exporting default Component + `isCsv`
 *   2. add one entry here: { name: 'csv', test: isCsv, Component: CsvBlock }
 * No existing file is modified — open-closed.
 */
import type { ComponentType } from 'react'
import JsonBlock, { isJson } from './blocks/JsonBlock'
import HtmlBlock, { isHtml } from './blocks/HtmlBlock'

export interface FormatRenderer {
  /** Lower-case language key; matches fenced-code `language-<name>`. */
  name: string
  /** Whole-message format detector. */
  test: (content: string) => boolean
  /** Renderer for both whole-message and fenced-block cases. */
  Component: ComponentType<{ content: string }>
}

export const formatRenderers: FormatRenderer[] = [
  { name: 'json', test: isJson, Component: JsonBlock },
  { name: 'html', test: isHtml, Component: HtmlBlock },
]

export const rendererByLang = new Map(
  formatRenderers.map(r => [r.name, r.Component]),
)

/** Return the renderer for a whole message, or null to fall back to markdown. */
export function detectFormat(content: string): ComponentType<{ content: string }> | null {
  return formatRenderers.find(r => r.test(content))?.Component ?? null
}
