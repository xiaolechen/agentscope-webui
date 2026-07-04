import axios from 'axios'
import { useAuthStore } from '@/store/auth'

export const apiClient = axios.create({ baseURL: '/api' })

// Fixed agentscope tenant namespace — web UI manages its own RBAC on top
export const WEBUI_TENANT = 'webui'

// Guard: multiple concurrent 401s (e.g. React Query refetchOnWindowFocus firing
// all stale queries at once) must not each trigger a separate page reload.
let _redirectingToLogin = false

apiClient.interceptors.request.use(cfg => {
  const token = localStorage.getItem('token')
  if (token) cfg.headers.Authorization = `Bearer ${token}`
  cfg.headers['x-user-id'] = WEBUI_TENANT
  return cfg
})

apiClient.interceptors.response.use(
  r => r,
  err => {
    const status = err.response?.status
    if (status === 401) {
      // Token expired/invalid. The first 401 drives the redirect to /login;
      // subsequent concurrent 401s (e.g. React Query refetching several stale
      // queries at once) are swallowed by the guard. We return a perpetually-
      // pending promise instead of rejecting: a reject would propagate to
      // caller .catch / mutation onError handlers (e.g. KnowledgePage) that
      // surface err.response.data.detail via alert() — popping a
      // "Not authenticated" dialog that BLOCKS the very redirect we queued.
      // The pending promise keeps every caller quiet while the full-page
      // reload to /login proceeds unimpeded.
      if (!_redirectingToLogin) {
        _redirectingToLogin = true
        // Clear Zustand state + localStorage so any still-mounted component
        // doesn't re-request with the stale token before the reload lands.
        useAuthStore.getState().logout()
        // replace() avoids leaving the broken page in browser history.
        window.location.replace('/login')
      }
      return new Promise(() => {})
    }
    // Log non-401 errors centrally so developers see them in the console
    // even when call sites use silent .catch(() => {}) handlers.
    const method = (err.config?.method ?? 'unknown').toUpperCase()
    const url = err.config?.url ?? ''
    const detail = err.response?.data?.detail ?? err.message ?? 'unknown'
    console.error(`[api] ${method} ${url} → ${status ?? 'network'}: ${detail}`)
    return Promise.reject(err)
  }
)

/** Redirect to /login and clear auth — callable outside React tree (e.g. SSE). */
export function redirectToLogin() {
  if (_redirectingToLogin) return
  _redirectingToLogin = true
  useAuthStore.getState().logout()
  window.location.replace('/login')
}
