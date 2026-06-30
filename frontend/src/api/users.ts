import { apiClient } from './client'

export const usersApi = {
  list: () => apiClient.get('/users/').then(r => r.data),
  create: (body: { username: string; password: string; role: string; bound_agent_ids: string[] }) =>
    apiClient.post('/users/', body).then(r => r.data),
  update: (id: string, body: { password?: string; role?: string; bound_agent_ids?: string[] }) =>
    apiClient.patch(`/users/${id}`, body).then(r => r.data),
  delete: (id: string) => apiClient.delete(`/users/${id}`),
}
