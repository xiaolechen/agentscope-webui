import { create } from 'zustand'

interface AuthState {
  token: string | null
  role: 'admin' | 'user' | null
  userId: string | null
  username: string | null
  boundAgentIds: string[]
  setAuth: (data: { token: string; role: 'admin' | 'user'; userId: string; username: string }) => void
  setBoundAgents: (ids: string[]) => void
  logout: () => void
}

export const useAuthStore = create<AuthState>((set) => ({
  token: localStorage.getItem('token'),
  role: localStorage.getItem('role') as 'admin' | 'user' | null,
  userId: localStorage.getItem('userId'),
  username: localStorage.getItem('username'),
  boundAgentIds: JSON.parse(localStorage.getItem('boundAgentIds') ?? '[]'),
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
  logout: () => {
    ['token', 'role', 'userId', 'username', 'boundAgentIds'].forEach(k => localStorage.removeItem(k))
    set({ token: null, role: null, userId: null, username: null, boundAgentIds: [] })
  },
}))
