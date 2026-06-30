import { apiClient } from './client'

export interface SessionConfig { name: string }
export interface SessionRecord {
  id: string
  agent_id: string
  config: SessionConfig
  updated_at?: string
}

// API wraps each session under a "session" key: { session: {...}, ... }
function unwrap(item: any): SessionRecord {
  return item.session ?? item
}

export const sessionsApi = {
  listByAgent: async (agent_id: string): Promise<SessionRecord[]> => {
    const { data } = await apiClient.get<{ sessions: any[] }>('/sessions/', { params: { agent_id } })
    return (data.sessions ?? []).map(unwrap)
  },
  create: async (agent_id: string, name: string, chat_model_config?: unknown): Promise<string> => {
    const { data } = await apiClient.post<{ session_id: string }>('/sessions/', {
      agent_id,
      name,
      ...(chat_model_config ? { chat_model_config } : {}),
    })
    return data.session_id
  },
  update: async (id: string, agent_id: string, body: Partial<SessionConfig>) => {
    const { data } = await apiClient.patch<SessionRecord>(`/sessions/${id}`, body, { params: { agent_id } })
    return data
  },
  delete: async (id: string, agent_id: string) => {
    await apiClient.delete(`/sessions/${id}`, { params: { agent_id } })
  },
  messages: async (session_id: string, agent_id: string, offset = 0, limit = 50) => {
    const { data } = await apiClient.get(`/sessions/${session_id}/messages`, {
      params: { agent_id, offset, limit },
    })
    return data
  },
}

