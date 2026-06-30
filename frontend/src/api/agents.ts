import { apiClient } from './client'

export interface AgentData {
  name: string
  system_prompt?: string
  [key: string]: unknown
}

export interface AgentRecord {
  id: string
  data: AgentData
}

export const agentsApi = {
  list: async (): Promise<AgentRecord[]> => {
    const { data } = await apiClient.get<{ agents: AgentRecord[] }>('/agent/')
    return data.agents
  },
  create: async (name: string, system_prompt: string): Promise<string> => {
    const { data } = await apiClient.post<{ agent_id: string }>('/agent/', { name, system_prompt })
    return data.agent_id
  },
  update: async (id: string, body: Partial<AgentData> & Record<string, unknown>) => {
    const { data } = await apiClient.patch<AgentRecord>(`/agent/${id}`, body)
    return data
  },
  delete: async (id: string) => {
    await apiClient.delete(`/agent/${id}`)
  },
}
