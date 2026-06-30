/**
 * Convert a user-selected File into agentscope message content blocks.
 *
 * agentscope `/chat/` is JSON-only but accepts `DataBlock` (base64 media) and
 * `TextBlock`. So file upload is purely client-side — no upload endpoint.
 *
 * v1 scope: images, audio, and text-based files. Binary docs (pdf/docx/...)
 * are rejected (agentscope's default formatter only accepts image/* and
 * audio/* media types; other binary would be silently dropped).
 *
 * Open-closed: adding a new handler (e.g. a future PDF text-extraction
 * handler backed by a new endpoint) = add one entry to `handlers`. Existing
 * handlers are untouched.
 */

export const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5MB

export interface ContentBlock {
  type: 'text' | 'data'
  id: string
  text?: string
  source?: { type: 'base64'; data: string; media_type: string }
  name?: string
}

export type FileError = 'tooLarge' | 'unsupported'

interface FileHandler {
  name: string
  test: (f: File) => boolean
  toBlock: (f: File) => Promise<ContentBlock>
}

const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'mdx', 'json', 'csv', 'tsv', 'yaml', 'yml', 'xml',
  'html', 'htm', 'js', 'jsx', 'ts', 'tsx', 'py', 'go', 'rs', 'java', 'c',
  'cpp', 'h', 'sh', 'bash', 'sql', 'log', 'ini', 'toml', 'env', 'conf',
  'css', 'scss', 'vue', 'rb', 'php', 'kt', 'swift', 'dart', 'r', 'lua', 'pl', 'ps1',
])

const isTextExt = (name: string): boolean =>
  TEXT_EXT.has(name.split('.').pop()?.toLowerCase() ?? '')

let _idCounter = 0
const uid = (): string => {
  // Stable enough for client-side block ids; avoid crypto in hot loop.
  _idCounter += 1
  return `blk-${Date.now().toString(36)}-${_idCounter}`
}

/** Read an image/audio file as base64 via readAsDataURL, parse out media_type. */
function readAsBase64(f: File): Promise<{ data: string; media_type: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? '')
      // data:<media_type>;base64,<data>
      const m = /^data:([^;]+);base64,(.*)$/.exec(result)
      if (!m) { reject(new Error('failed to read file as data URL')); return }
      resolve({ media_type: m[1], data: m[2] })
    }
    reader.onerror = () => reject(reader.error ?? new Error('read error'))
    reader.readAsDataURL(f)
  })
}

const mediaToBlock = async (f: File): Promise<ContentBlock> => {
  const { data, media_type } = await readAsBase64(f)
  return { type: 'data', id: uid(), source: { type: 'base64', data, media_type }, name: f.name }
}

const textToBlock = async (f: File): Promise<ContentBlock> => {
  const content = await f.text()
  return {
    type: 'text',
    id: uid(),
    text: `📄 ${f.name}\n\`\`\`\n${content}\n\`\`\``,
  }
}

const handlers: FileHandler[] = [
  { name: 'image', test: f => f.type.startsWith('image/'), toBlock: mediaToBlock },
  { name: 'audio', test: f => f.type.startsWith('audio/'), toBlock: mediaToBlock },
  { name: 'text', test: f => isTextExt(f.name), toBlock: textToBlock },
]

export async function fileToBlock(
  f: File,
): Promise<{ block?: ContentBlock; error?: FileError }> {
  if (f.size > MAX_FILE_SIZE) return { error: 'tooLarge' }
  const h = handlers.find(h => h.test(f))
  if (!h) return { error: 'unsupported' }
  return { block: await h.toBlock(f) }
}

/** Accept attribute for the hidden <input type=file>, matching the handlers above. */
export const FILE_ACCEPT =
  'image/*,audio/*,.' + [...TEXT_EXT].join(',.')
