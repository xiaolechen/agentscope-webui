import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { X, Save } from 'lucide-react'
import { tenantsApi, type UserResources } from '@/api/tenants'
import { agentsApi, type AgentRecord } from '@/api/agents'
import { useAuthStore } from '@/store/auth'

interface Props {
  tenantId: string
  userId: string
  username: string
  onClose: () => void
}

/** Tenant-admin dialog: assign a subset of the tenant's agent pool to a
 *  specific member. The backend rejects ids outside the tenant's
 *  assigned_agents pool.
 *
 *  Only agents are configured per-user for now; mcps/skills are governed by
 *  the tenant pool. Any previously-assigned mcps/skills are preserved on
 *  save (read from the current resources, returned unchanged). */
export default function MemberResourcesDialog({ tenantId, userId, username, onClose }: Props) {
  const { t } = useTranslation()
  const qc = useQueryClient()

  const { data: myTenant } = useQuery({ queryKey: ['my-tenant'], queryFn: tenantsApi.getMyTenant })
  const { data: resources } = useQuery({
    queryKey: ['member-resources', tenantId, userId],
    queryFn: () => tenantsApi.getMemberResources(tenantId, userId),
  })
  const { data: agents = [] } = useQuery({ queryKey: ['agents'], queryFn: agentsApi.list })

  const [agentsSel, setAgentsSel] = useState<string[]>([])
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    if (resources) setAgentsSel(resources.agents)
  }, [resources])

  const saveMut = useMutation({
    mutationFn: (r: UserResources) => tenantsApi.setMemberResources(tenantId, userId, r),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['member-resources', tenantId, userId] })
      onClose()
    },
    onError: (e: unknown) => {
      const detail = (e as any)?.response?.data?.detail
      setSaveError(typeof detail === 'string' ? detail : (e instanceof Error ? e.message : 'Save failed'))
    },
  })

  const toggle = (id: string) =>
    setAgentsSel(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])

  // Catalog entries that are within the tenant pool (display only those).
  const poolAgents = agents.filter(a => myTenant?.assigned_agents.includes(a.id) ?? false)

  return (
    <div className="as-overlay">
      <div className="as-dialog" style={{ maxWidth: 560, maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
        <div className="flex items-center gap-2 mb-3 shrink-0">
          <h3 className="text-base font-semibold flex-1" style={{ color: 'var(--as-ink)' }}>
            {t('tenants.resources.title', { name: username })}
          </h3>
          <button onClick={onClose} className="as-btn as-btn-ghost" style={{ padding: '5px' }}><X size={14} /></button>
        </div>

        <div className="overflow-y-auto pr-1 space-y-4" style={{ flex: 1, minHeight: 0 }}>
          <div>
            <p className="as-caption mb-2" style={{ color: 'var(--as-ink-80)', fontWeight: 600 }}>
              {t('tenants.detail.resources.agents')}
            </p>
            <div className="space-y-1 max-h-64 overflow-y-auto rounded-[var(--as-r-sm)] p-2"
              style={{ border: '1px solid var(--as-hairline)' }}>
              {poolAgents.map((a: AgentRecord) => (
                <label key={a.id} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="checkbox" checked={agentsSel.includes(a.id)} onChange={() => toggle(a.id)} style={{ accentColor: 'var(--as-primary)' }} />
                  <span className="truncate">{a.data.name}</span>
                </label>
              ))}
              {!poolAgents.length && <p className="text-xs" style={{ color: 'var(--as-ink-48)' }}>{t('tenants.detail.resources.emptyAgents')}</p>}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-3 shrink-0 border-t" style={{ borderColor: 'var(--as-hairline)' }}>
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm" style={{ color: 'var(--as-ink-80)' }}>
            {t('common.button.cancel')}
          </button>
          <button
            type="button"
            // Preserve any existing mcps/skills (not edited here) — only agents
            // are managed per-user for now; the tenant pool still governs the rest.
            onClick={() => { setSaveError(null); saveMut.mutate({
              agents: agentsSel,
              mcps: resources?.mcps ?? [],
              skills: resources?.skills ?? [],
            }) }}
            disabled={saveMut.isPending}
            className="as-btn as-btn-primary as-btn-sm"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: saveMut.isPending ? 0.5 : 1 }}
          >
            <Save size={13} />{saveMut.isPending ? t('common.status.saving') : t('common.button.save')}
          </button>
        </div>
        {saveError && (
          <p className="text-xs mt-2 shrink-0" style={{ color: 'rgb(185,28,28)' }}>{saveError}</p>
        )}
      </div>
    </div>
  )
}

// Re-export for callers that need the role gate.
export const useCanAssignResources = () => {
  const role = useAuthStore(s => s.role)
  // tenant_admin (in their active tenant) and super-admin can assign.
  return role === 'admin' || role === 'tenant_admin'
}
