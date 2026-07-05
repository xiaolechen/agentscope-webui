import { apiClient } from './client'
import type { MenuPermission } from '@/store/auth'

/** A tenant is the unit of multi-tenant isolation. Created by the super-admin;
 *  controls which sidebar pages its members see (menu_permissions) and which
 *  agents/mcps/skills/credentials they may use (assigned_*). */
export interface Tenant {
  id: string
  name: string                       // URL-safe slug, unique
  display_name: string
  created_by: string
  created_at: string
  menu_permissions: MenuPermission[]
  assigned_agents: string[]
  assigned_mcps: string[]
  assigned_skills: string[]
  assigned_credentials: string[]
  org_structure: unknown[]
  member_count?: number
}

export type MemberRole = 'tenant_admin' | 'user'

export interface TenantMember {
  id: string
  username: string
  role: string
  org_path: string | null
  is_tenant_admin: boolean
}

export interface CreateTenantBody {
  name: string
  display_name: string
  menu_permissions?: MenuPermission[]
}

/** Update body — all fields optional. `null`-able fields use `undefined` to
 *  mean "leave unchanged" (PATCH-style semantics on a PUT endpoint). */
export type UpdateTenantBody = Partial<
  Pick<Tenant, 'display_name' | 'menu_permissions' |
  'assigned_agents' | 'assigned_mcps' | 'assigned_skills' | 'assigned_credentials'>
>

export const tenantsApi = {
  list: () => apiClient.get<Tenant[]>('/webui/tenants').then(r => r.data),
  // The caller's own tenant — any tenant member (not just admin). Used by the
  // non-admin Users page to filter the bound-agent picker to assigned_agents.
  getMyTenant: () => apiClient.get<Tenant>('/webui/tenants/my-tenant').then(r => r.data),
  // The caller's effective resource set in their active tenant. Used to filter
  // agent/skill/mcp pickers so users only see what they're assigned.
  getMyResources: (): Promise<UserResources> =>
    apiClient.get('/webui/tenants/my-resources').then(r => r.data),
  get: (id: string) => apiClient.get<Tenant>(`/webui/tenants/${id}`).then(r => r.data),
  create: (body: CreateTenantBody) =>
    apiClient.post<Tenant>('/webui/tenants', body).then(r => r.data),
  update: (id: string, body: UpdateTenantBody) =>
    apiClient.put<Tenant>(`/webui/tenants/${id}`, body).then(r => r.data),
  delete: (id: string) => apiClient.delete(`/webui/tenants/${id}`),

  listMembers: (id: string) =>
    apiClient.get<TenantMember[]>(`/webui/tenants/${id}/members`).then(r => r.data),
  addMembers: (id: string, user_ids: string[], role: MemberRole) =>
    apiClient.post(`/webui/tenants/${id}/members`, { user_ids, role }).then(r => r.data),
  removeMember: (id: string, user_id: string) =>
    apiClient.delete(`/webui/tenants/${id}/members/${user_id}`),
  setMemberRole: (id: string, user_id: string, role: MemberRole) =>
    apiClient.put(`/webui/tenants/${id}/members/${user_id}`, { role }).then(r => r.data),

  // Per-user resource assignment within a tenant (agents/mcps/skills). Each
  // must be a subset of the tenant's assigned_* pool; the backend enforces it.
  getMemberResources: (id: string, userId: string): Promise<UserResources> =>
    apiClient.get(`/webui/tenants/${id}/members/${userId}/resources`).then(r => r.data),
  setMemberResources: (id: string, userId: string, resources: UserResources) =>
    apiClient.put(`/webui/tenants/${id}/members/${userId}/resources`, resources).then(r => r.data),
}

export interface UserResources {
  agents: string[]
  mcps: string[]
  skills: string[]
}
