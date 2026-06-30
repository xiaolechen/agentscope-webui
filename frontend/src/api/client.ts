import axios from 'axios'

export const apiClient = axios.create({ baseURL: '/api' })

// Fixed agentscope tenant namespace — web UI manages its own RBAC on top
const WEBUI_TENANT = 'webui'

apiClient.interceptors.request.use(cfg => {
  const token = localStorage.getItem('token')
  if (token) cfg.headers.Authorization = `Bearer ${token}`
  cfg.headers['x-user-id'] = WEBUI_TENANT
  return cfg
})

apiClient.interceptors.response.use(
  r => r,
  err => {
    if (err.response?.status === 401) {
      localStorage.removeItem('token')
      window.location.href = '/login'
    }
    return Promise.reject(err)
  }
)
