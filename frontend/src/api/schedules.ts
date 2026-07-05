import { apiClient } from './client'

export interface ScheduleScope { all?: boolean; schedule_ids?: string[] }

// Schedules are creator-owned (same model as sessions): admin sees all,
// tenant_admin sees their tenant members' union, a member sees only their own.
// The agentscope /schedule/ endpoint lives in a shared namespace, so the list
// is fetched globally then filtered by the caller's ownership scope.
async function fetchScopedList(): Promise<any[]> {
  const [schedulesRes, scopeRes] = await Promise.all([
    apiClient.get('/schedule/').catch(() => ({ data: { schedules: [] } })),
    apiClient.get<ScheduleScope>('/webui/my-schedule-ids').catch(() => ({ data: { all: true } as ScheduleScope })),
  ])
  const all = schedulesRes.data.schedules ?? []
  const scope = scopeRes.data
  if (scope?.all) return all
  const allowed = new Set(scope?.schedule_ids ?? [])
  return all.filter((s: any) => allowed.has(s.id))
}

export const schedulesApi = {
  list: () => fetchScopedList(),
  create: (body: unknown) => apiClient.post('/schedule/', body).then(r => r.data),
  update: (id: string, body: unknown) => apiClient.patch(`/schedule/${id}`, body),
  delete: (id: string) => apiClient.delete(`/schedule/${id}`),
  runNow: (id: string) => apiClient.post(`/webui/schedule/${id}/run`).then(r => r.data),
  sessions: (id: string) => apiClient.get(`/schedule/${id}/sessions`).then(r => r.data.sessions),
}
