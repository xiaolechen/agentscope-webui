import { create } from 'zustand'
import type { UserRole, Membership } from '@/api/auth'
import { authApi } from '@/api/auth'

export type MenuPermission =
  | 'chat' | 'sessions' | 'knowledge' | 'schedules'
  | 'agents' | 'skills' | 'mcp'
  | 'credentials' | 'logs' | 'settings' | 'users'

interface AuthState {
  token: string | null
  role: UserRole | null
  userId: string | null
  username: string | null
  boundAgentIds: string[]
  tenantId: string | null              // active tenant id
  memberships: Membership[]            // all tenants the user belongs to
  menuPermissions: MenuPermission[]
  setAuth: (data: {
    token: string
    role: UserRole
    userId: string
    username: string
  }) => void
  setBoundAgents: (ids: string[]) => void
  setTenant: (tenantId: string | null, menuPermissions: MenuPermission[]) => void
  setMemberships: (memberships: Membership[]) => void
  switchTenant: (tenantId: string) => Promise<void>
  hasMenu: (perm: MenuPermission) => boolean
  logout: () => void
}

const LS_KEYS = [
  'token', 'role', 'userId', 'username', 'boundAgentIds',
  'tenantId', 'memberships', 'menuPermissions',
] as const

const parseMemberships = (raw: string | null): Membership[] => {
  try { return raw ? JSON.parse(raw) : [] } catch { return [] }
}

export const useAuthStore = create<AuthState>((set, get) => ({
  token: localStorage.getItem('token'),
  role: localStorage.getItem('role') as UserRole | null,
  userId: localStorage.getItem('userId'),
  username: localStorage.getItem('username'),
  boundAgentIds: JSON.parse(localStorage.getItem('boundAgentIds') ?? '[]'),
  tenantId: localStorage.getItem('tenantId') || null,
  memberships: parseMemberships(localStorage.getItem('memberships')),
  menuPermissions: JSON.parse(localStorage.getItem('menuPermissions') ?? '[]'),
  setAuth: ({ token, role, userId, username }) => {
    localStorage.setItem('token', token)
    localStorage.setItem('role', role)
    localStorage.setItem('userId', userId)
    localStorage.setItem('username', username)
    set({ token, role, userId, username })
  },
  setBoundAgents: (ids) => {
    localStorage.setItem('boundAgentIds', JSON.stringify(ids))
    set({ boundAgentIds: ids })
  },
  setTenant: (tenantId, menuPermissions) => {
    localStorage.setItem('tenantId', tenantId ?? '')
    localStorage.setItem('menuPermissions', JSON.stringify(menuPermissions))
    set({ tenantId, menuPermissions })
  },
  setMemberships: (memberships) => {
    localStorage.setItem('memberships', JSON.stringify(memberships))
    set({ memberships })
  },
  switchTenant: async (tenantId) => {
    // New JWT carries the active tenant + the role held in it. After storing
    // it, re-fetch /auth/me so menuPermissions reflect the new tenant.
    const res = await authApi.switchTenant(tenantId)
    const me = await authApi.me()
    localStorage.setItem('token', res.access_token)
    localStorage.setItem('role', res.role)
    localStorage.setItem('tenantId', me.active_tenant_id ?? '')
    localStorage.setItem('menuPermissions', JSON.stringify(me.menu_permissions))
    localStorage.setItem('memberships', JSON.stringify(me.memberships))
    set({
      token: res.access_token,
      role: res.role,
      tenantId: me.active_tenant_id,
      menuPermissions: me.menu_permissions as MenuPermission[],
      memberships: me.memberships,
    })
  },
  hasMenu: (perm) => {
    const { role, menuPermissions } = get()
    // Super-admin bypasses menu gating — they see everything.
    return role === 'admin' || menuPermissions.includes(perm)
  },
  logout: () => {
    LS_KEYS.forEach(k => localStorage.removeItem(k))
    // Clear user-specific localStorage so the next login doesn't inherit the
    // previous account's pinned KB sessions, etc. Preferences (theme, language,
    // nav collapse) are intentionally kept — they're not user-scoped data.
    const toRemove: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && key.startsWith('kb-session:')) toRemove.push(key)
    }
    toRemove.forEach(k => localStorage.removeItem(k))
    set({
      token: null, role: null, userId: null, username: null,
      boundAgentIds: [], tenantId: null, memberships: [], menuPermissions: [],
    })
  },
}))
