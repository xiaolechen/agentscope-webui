import { apiClient } from './client'

export interface LoginResponse {
  access_token: string
  token_type: string
  role: 'admin' | 'user'
  user_id: string
}

export interface MeResponse {
  id: string
  username: string
  role: 'admin' | 'user'
  bound_agent_ids: string[]
}

export const authApi = {
  login: async (username: string, password: string): Promise<LoginResponse> => {
    const form = new URLSearchParams({ username, password })
    const { data } = await apiClient.post<LoginResponse>('/auth/login', form)
    return data
  },
  me: async (): Promise<MeResponse> => {
    const { data } = await apiClient.get<MeResponse>('/auth/me')
    return data
  },
}
