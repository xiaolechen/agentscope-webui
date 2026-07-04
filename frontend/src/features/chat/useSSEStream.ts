import { useCallback, useRef, useState } from 'react'
import { redirectToLogin, WEBUI_TENANT } from '@/api/client'

export interface AgentEvent {
  type: string
  id?: string
  reply_id?: string
  block_id?: string
  delta?: string
  name?: string
  tool_calls?: unknown[]
  hint?: unknown
  [key: string]: unknown
}

export interface StreamState {
  textChunks: Record<string, string>
  toolEvents: AgentEvent[]
  pendingConfirm: AgentEvent | null
  streaming: boolean
  done: boolean
}

const DONE_TYPES = new Set(['REPLY_END', 'EXCEED_MAX_ITERS'])

/**
 * Resolve the SSE stream URL for the given /api/... proxy path.
 *
 * Dev (Vite): the dev server's compression middleware buffers SSE, so we
 * bypass the /api proxy and connect directly to the backend on :8000
 * (strip the /api prefix).
 *
 * Deployed (reverse proxy): there is no Vite, so we go through the SAME
 * origin and KEEP the /api prefix — the reverse proxy is configured to
 * route /api/* to the backend (it strips /api, same as for every other
 * API call). Stripping /api here would send /sessions/.../stream to the
 * static SPA server, which returns index.html (no events → stream hangs
 * forever). agentscope sends `X-Accel-Buffering: no`, so a correctly
 * configured nginx proxy won't buffer SSE; if your proxy buffers it, set
 * `proxy_buffering off` for the stream path.
 */
function resolveStreamUrl(proxyUrl: string): string {
  const origin = window.location.origin
  // Sandbox URL pattern: contains port as part of subdomain
  if (origin.match(/-5173\./)) {
    return origin.replace('-5173.', '-8000.') + proxyUrl.replace(/^\/api/, '')
  }
  if (origin.match(/localhost:5173/)) {
    return 'http://localhost:8000' + proxyUrl.replace(/^\/api/, '')
  }
  if (origin.match(/127\.0\.0\.1:5173/)) {
    return 'http://127.0.0.1:8000' + proxyUrl.replace(/^\/api/, '')
  }
  // Deployed behind a reverse proxy — same origin, keep /api.
  return proxyUrl
}

export function useSSEStream() {
  const [state, setState] = useState<StreamState>({
    textChunks: {}, toolEvents: [], pendingConfirm: null, streaming: false, done: false,
  })
  const bufferRef = useRef<Record<string, string>>({})
  const abortRef = useRef<AbortController | null>(null)

  const reset = useCallback(() => {
    abortRef.current?.abort()
    bufferRef.current = {}
    setState({ textChunks: {}, toolEvents: [], pendingConfirm: null, streaming: false, done: false })
  }, [])

  const start = useCallback((proxyUrl: string) => {
    abortRef.current?.abort()
    bufferRef.current = {}
    setState({ textChunks: {}, toolEvents: [], pendingConfirm: null, streaming: true, done: false })

    const controller = new AbortController()
    abortRef.current = controller

    // Bypass Vite proxy in dev (it buffers SSE); in deployed envs go through
    // the reverse proxy with the /api prefix (see resolveStreamUrl).
    // proxyUrl: /api/sessions/{id}/stream?agent_id=...
    const directUrl = resolveStreamUrl(proxyUrl)

    const token = localStorage.getItem('token')
    const headers: HeadersInit = { 'x-user-id': WEBUI_TENANT }
    if (token) headers['Authorization'] = `Bearer ${token}`

    async function readStream() {
      try {
        const resp = await fetch(directUrl, {
          headers,
          signal: controller.signal,
          // Prevent browser/proxy compression buffering
          cache: 'no-store',
        })

        if (!resp.ok || !resp.body) {
          if (resp.status === 401) {
            // Token expired or missing — SSE bypasses axios interceptor, so
            // we handle the redirect here instead of showing nothing to the user.
            setState(s => ({ ...s, streaming: false, done: true }))
            redirectToLogin()
            return
          }
          // Read the response body to get the actual error detail from the backend.
          const body = await resp.text().catch(() => '(unreadable)')
          console.warn('[SSE] stream failed:', resp.status, directUrl, body)
          setState(s => ({ ...s, streaming: false, done: true }))
          return
        }

        const reader = resp.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buf += decoder.decode(value, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''

          for (const line of lines) {
            if (!line.startsWith('data:')) continue
            const json = line.slice(5).trim()
            if (!json) continue
            try {
              const event: AgentEvent = JSON.parse(json)
              const replyId = event.reply_id ?? 'default'

              if (event.type === 'TEXT_BLOCK_DELTA' && event.delta) {

                bufferRef.current[replyId] = (bufferRef.current[replyId] ?? '') + event.delta
                const snapshot = { ...bufferRef.current }
                setState(prev => ({ ...prev, textChunks: snapshot }))
              } else if (event.type === 'TOOL_CALL_START' || event.type === 'TOOL_CALL_END') {
                setState(prev => ({ ...prev, toolEvents: [...prev.toolEvents, event] }))
              } else if (event.type === 'REQUIRE_USER_CONFIRM') {
                setState(prev => ({ ...prev, pendingConfirm: event }))
              } else if (DONE_TYPES.has(event.type)) {
                setState(prev => ({ ...prev, streaming: false, done: true }))
                reader.cancel()
                return
              }
            } catch { /* ignore parse errors */ }
          }
        }

        setState(s => ({ ...s, streaming: false, done: true }))
      } catch (err: any) {
        if (err?.name !== 'AbortError') {
          console.warn('[SSE] stream error:', err)
          setState(s => ({ ...s, streaming: false, done: true }))
        }
      }
    }

    readStream()
  }, [])

  const stop = useCallback(() => {
    abortRef.current?.abort()
    setState(s => ({ ...s, streaming: false }))
  }, [])

  return { state, start, stop, reset }
}
