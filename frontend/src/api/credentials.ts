import { apiClient } from './client'

export interface CredentialRecord { id: string; data: Record<string, unknown> }

export const credentialsApi = {
  list: async (): Promise<CredentialRecord[]> => {
    const { data } = await apiClient.get<{ credentials: CredentialRecord[] }>('/credential/')
    return data.credentials
  },
  create: async (cdata: Record<string, unknown>): Promise<string> => {
    const { data } = await apiClient.post<{ credential_id: string }>('/credential/', { data: cdata })
    return data.credential_id
  },
  update: async (id: string, cdata: Record<string, unknown>) => {
    const { data } = await apiClient.patch<CredentialRecord>(`/credential/${id}`, { data: cdata })
    return data
  },
  delete: async (id: string) => { await apiClient.delete(`/credential/${id}`) },
  models: async (provider: string) => {
    const { data } = await apiClient.get<{ models: { name: string; label: string }[] }>('/model/', { params: { provider } })
    return data.models
  },
}
