import { apiClient } from './client'

export const schedulesApi = {
  list: () => apiClient.get('/schedule/').then(r => r.data.schedules ?? []),
  create: (body: unknown) => apiClient.post('/schedule/', body).then(r => r.data),
  update: (id: string, body: unknown) => apiClient.patch(`/schedule/${id}`, body),
  delete: (id: string) => apiClient.delete(`/schedule/${id}`),
  runNow: (id: string) => apiClient.post(`/webui/schedule/${id}/run`).then(r => r.data),
  sessions: (id: string) => apiClient.get(`/schedule/${id}/sessions`).then(r => r.data.sessions),
}
