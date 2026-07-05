import { apiClient } from './client'

export type UserRole = 'admin' | 'tenant_admin' | 'user'

export interface Membership {
  tenant_id: string
  role: UserRole
  display_name: string
}

export interface LoginResponse {
  access_token: string
  token_type: string
  role: UserRole
  user_id: string
}

export interface MeResponse {
  id: string
  username: string
  role: UserRole
  bound_agent_ids: string[]
  tenant_id: string | null
  active_tenant_id: string | null
  menu_permissions: string[]
  memberships: Membership[]
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
  // Switch the active tenant. Returns a fresh JWT carrying the new tenant +
  // the role the user holds in it.
  switchTenant: async (tenantId: string): Promise<LoginResponse> => {
    const { data } = await apiClient.post<LoginResponse>(
      '/auth/switch-tenant', null, { params: { target_tenant_id: tenantId } },
    )
    return data
  },
}
