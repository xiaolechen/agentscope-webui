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
    if (status === 401 && !_redirectingToLogin) {
      _redirectingToLogin = true
      // Clear both Zustand state and localStorage before navigating so any
      // component still mounted doesn't re-request with a stale token.
      useAuthStore.getState().logout()
      // replace() avoids leaving the broken page in browser history.
      window.location.replace('/login')
    } else if (status !== 401) {
      // Log all non-401 errors centrally so developers see them in the console
      // even when call sites use silent .catch(() => {}) handlers.
      const method = (err.config?.method ?? 'unknown').toUpperCase()
      const url = err.config?.url ?? ''
      const detail = err.response?.data?.detail ?? err.message ?? 'unknown'
      console.error(`[api] ${method} ${url} → ${status ?? 'network'}: ${detail}`)
    }
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
