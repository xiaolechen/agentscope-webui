import { apiClient } from './client'

export type UserRole = 'admin' | 'tenant_admin' | 'user'

export interface UserRecord {
  id: string
  username: string
  role: UserRole
  bound_agent_ids: string[]
  tenant_id: string | null
}

/** Per-user resource subset (agents/mcps/skills). Only sent when a
 *  tenant_admin creates a regular user; ignored otherwise. */
export interface UserResourcesBody {
  agents: string[]
  mcps: string[]
  skills: string[]
}

export const usersApi = {
  list: async (): Promise<UserRecord[]> => {
    const { data } = await apiClient.get<UserRecord[]>('/users/')
    return data
  },
  create: (body: {
    username: string
    password: string
    role: UserRole
    bound_agent_ids: string[]
    tenant_id?: string | null
    resources?: UserResourcesBody
  }) => apiClient.post('/users/', body).then(r => r.data),
  update: (id: string, body: {
    password?: string
    role?: UserRole
    bound_agent_ids?: string[]
    // null detaches from tenant; undefined leaves it unchanged.
    tenant_id?: string | null
  }) => apiClient.patch(`/users/${id}`, body).then(r => r.data),
  delete: (id: string) => apiClient.delete(`/users/${id}`),
}
