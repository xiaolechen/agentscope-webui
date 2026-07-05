import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { X, Save } from 'lucide-react'
import { tenantsApi, type MemberRole } from '@/api/tenants'
import { usersApi } from '@/api/users'
import { agentsApi, type AgentRecord } from '@/api/agents'
import { credentialsApi, type CredentialRecord } from '@/api/credentials'
import { webuiApi, type McpDef, type SkillDef } from '@/api/webui'
import type { MenuPermission } from '@/store/auth'

type DetailTab = 'perms' | 'resources' | 'members'

// `labelKey` typed as a literal union so t() accepts it without a defaultValue.
const MENU_GROUPS: {
  labelKey: 'nav.groups.workspace' | 'nav.groups.configuration' | 'nav.groups.system'
  perms: MenuPermission[]
}[] = [
  { labelKey: 'nav.groups.workspace', perms: ['chat', 'sessions', 'knowledge', 'schedules'] },
  { labelKey: 'nav.groups.configuration', perms: ['agents', 'skills', 'mcp'] },
  { labelKey: 'nav.groups.system', perms: ['credentials', 'logs', 'settings', 'users'] },
]

// Menu perm → the i18n key under `nav.*` that labels the matching sidebar item.
// `as const` so the values form a literal union accepted by t().
const PERM_LABEL_KEY = {
  chat: 'nav.chat', sessions: 'nav.sessions', knowledge: 'nav.knowledge', schedules: 'nav.schedules',
  agents: 'nav.agents', skills: 'nav.skills', mcp: 'nav.mcp',
  credentials: 'nav.credentials', logs: 'nav.logs', settings: 'nav.settings', users: 'nav.users',
} as const

interface Props {
  tenantId: string
  onClose: () => void
}

export default function TenantDetailDialog({ tenantId, onClose }: Props) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [tab, setTab] = useState<DetailTab>('perms')

  const { data: tenant } = useQuery({ queryKey: ['tenant', tenantId], queryFn: () => tenantsApi.get(tenantId) })
  const { data: members = [] } = useQuery({ queryKey: ['tenant-members', tenantId], queryFn: () => tenantsApi.listMembers(tenantId) })
  const { data: users = [] } = useQuery({ queryKey: ['users'], queryFn: usersApi.list })
  const { data: agents = [] } = useQuery({ queryKey: ['agents'], queryFn: agentsApi.list })
  const { data: mcps = [] } = useQuery({ queryKey: ['mcp-lib'], queryFn: webuiApi.getMcpLib })
  const { data: skills = [] } = useQuery({ queryKey: ['skill-lib'], queryFn: webuiApi.getSkillLib })
  const { data: credentials = [] } = useQuery({ queryKey: ['credentials'], queryFn: credentialsApi.list })

  // Editable local copies, resynced whenever the server-side tenant loads.
  const [menuPerms, setMenuPerms] = useState<MenuPermission[]>([])
  const [assignedAgents, setAssignedAgents] = useState<string[]>([])
  const [assignedMcps, setAssignedMcps] = useState<string[]>([])
  const [assignedSkills, setAssignedSkills] = useState<string[]>([])
  const [assignedCreds, setAssignedCreds] = useState<string[]>([])

  useEffect(() => {
    if (!tenant) return
    setMenuPerms(tenant.menu_permissions)
    setAssignedAgents(tenant.assigned_agents)
    setAssignedMcps(tenant.assigned_mcps)
    setAssignedSkills(tenant.assigned_skills)
    setAssignedCreds(tenant.assigned_credentials)
  }, [tenant])

  const savePermsMut = useMutation({
    mutationFn: (perms: MenuPermission[]) => tenantsApi.update(tenantId, { menu_permissions: perms }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tenant', tenantId] })
      qc.invalidateQueries({ queryKey: ['tenants'] })
      onClose()
    },
  })
  const saveResourcesMut = useMutation({
    mutationFn: () => tenantsApi.update(tenantId, {
      assigned_agents: assignedAgents,
      assigned_mcps: assignedMcps,
      assigned_skills: assignedSkills,
      assigned_credentials: assignedCreds,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tenant', tenantId] })
      qc.invalidateQueries({ queryKey: ['tenants'] })
      onClose()
    },
  })
  const addMemberMut = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: MemberRole }) =>
      tenantsApi.addMembers(tenantId, [userId], role),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tenant-members', tenantId] }),
  })
  const removeMemberMut = useMutation({
    mutationFn: (userId: string) => tenantsApi.removeMember(tenantId, userId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tenant-members', tenantId] })
      qc.invalidateQueries({ queryKey: ['users'] })
    },
  })
  const setRoleMut = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: MemberRole }) =>
      tenantsApi.setMemberRole(tenantId, userId, role),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tenant-members', tenantId] }),
  })

  // Candidates for membership: non-admins not currently in *this* tenant.
  // Users already in another tenant are excluded (backend would 409).
  const memberIds = new Set(members.map(m => m.id))
  const memberCandidates = users.filter(u => u.role !== 'admin' && !u.tenant_id && !memberIds.has(u.id))

  const togglePerm = (p: MenuPermission) =>
    setMenuPerms(prev => prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p])
  const toggle = (setter: React.Dispatch<React.SetStateAction<string[]>>, id: string) =>
    setter(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])

  const permsDirty = !!tenant && !sameSet(menuPerms, tenant.menu_permissions)
  const resDirty = !!tenant && (
    !sameSet(assignedAgents, tenant.assigned_agents) ||
    !sameSet(assignedMcps, tenant.assigned_mcps) ||
    !sameSet(assignedSkills, tenant.assigned_skills) ||
    !sameSet(assignedCreds, tenant.assigned_credentials)
  )

  const tabs: { key: DetailTab; label: string }[] = [
    { key: 'perms', label: t('tenants.detail.tab.perms') },
    { key: 'resources', label: t('tenants.detail.tab.resources') },
    { key: 'members', label: t('tenants.detail.tab.members') },
  ]

  return (
    <div className="as-overlay">
      <div className="as-dialog" style={{ maxWidth: 720, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
        <div className="flex items-center gap-2 mb-3 shrink-0">
          <h3 className="text-base font-semibold flex-1" style={{ color: 'var(--as-ink)' }}>
            {tenant?.display_name ?? '…'}
          </h3>
          <button onClick={onClose} className="as-btn as-btn-ghost" style={{ padding: '5px' }}><X size={14} /></button>
        </div>

        <div className="flex gap-1 border-b mb-4 shrink-0" style={{ borderColor: 'var(--as-hairline)' }}>
          {tabs.map(tb => (
            <button key={tb.key} onClick={() => setTab(tb.key)}
              className="px-3 py-2 text-sm border-b-2 -mb-px"
              style={tab === tb.key
                ? { borderColor: 'var(--as-primary)', color: 'var(--as-primary)', fontWeight: 600 }
                : { borderColor: 'transparent', color: 'var(--as-ink-48)' }}>
              {tb.label}
            </button>
          ))}
        </div>

        <div className="overflow-y-auto pr-1" style={{ flex: 1, minHeight: 0 }}>
          {tab === 'perms' && (
            <div className="space-y-4">
              {MENU_GROUPS.map(group => (
                <div key={group.labelKey}>
                  <p className="as-caption mb-2" style={{ color: 'var(--as-ink-80)', fontWeight: 600 }}>{t(group.labelKey)}</p>
                  <div className="flex flex-wrap gap-2">
                    {group.perms.map(p => {
                      const on = menuPerms.includes(p)
                      return (
                        <button key={p} type="button" onClick={() => togglePerm(p)}
                          className="text-xs px-2.5 py-1.5 rounded-[var(--as-pill)] border transition-colors"
                          style={on
                            ? { background: 'var(--as-primary)', color: '#fff', borderColor: 'var(--as-primary)' }
                            : { background: 'var(--as-parchment)', color: 'var(--as-ink-80)', borderColor: 'var(--as-hairline)' }}>
                          {t(PERM_LABEL_KEY[p])}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
              <div className="flex justify-end pt-2">
                <button
                  onClick={() => savePermsMut.mutate(menuPerms)}
                  disabled={!permsDirty || savePermsMut.isPending}
                  className="as-btn as-btn-primary as-btn-sm"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: (!permsDirty || savePermsMut.isPending) ? 0.5 : 1 }}
                >
                  <Save size={13} />{savePermsMut.isPending ? t('common.status.saving') : t('common.button.save')}
                </button>
              </div>
            </div>
          )}

          {tab === 'resources' && (
            <div className="space-y-4">
              <ResourceList
                title={t('tenants.detail.resources.agents')}
                emptyHint={t('tenants.detail.resources.emptyAgents')}
                items={agents.map((a: AgentRecord) => ({ id: a.id, label: a.data.name }))}
                selected={assignedAgents}
                onToggle={id => toggle(setAssignedAgents, id)}
              />
              <ResourceList
                title={t('tenants.detail.resources.mcps')}
                emptyHint={t('tenants.detail.resources.emptyMcps')}
                items={mcps.map((m: McpDef) => ({ id: m.name, label: m.name }))}
                selected={assignedMcps}
                onToggle={id => toggle(setAssignedMcps, id)}
              />
              <ResourceList
                title={t('tenants.detail.resources.skills')}
                emptyHint={t('tenants.detail.resources.emptySkills')}
                items={skills.map((s: SkillDef) => ({ id: s.path, label: s.name }))}
                selected={assignedSkills}
                onToggle={id => toggle(setAssignedSkills, id)}
              />
              <ResourceList
                title={t('tenants.detail.resources.credentials')}
                emptyHint={t('tenants.detail.resources.emptyCredentials')}
                items={credentials.map((c: CredentialRecord) => ({ id: c.id, label: (c.data.name as string) ?? c.id.slice(0, 8) }))}
                selected={assignedCreds}
                onToggle={id => toggle(setAssignedCreds, id)}
              />
              <div className="flex justify-end pt-2">
                <button
                  onClick={() => saveResourcesMut.mutate()}
                  disabled={!resDirty || saveResourcesMut.isPending}
                  className="as-btn as-btn-primary as-btn-sm"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: (!resDirty || saveResourcesMut.isPending) ? 0.5 : 1 }}
                >
                  <Save size={13} />{saveResourcesMut.isPending ? t('common.status.saving') : t('common.button.save')}
                </button>
              </div>
            </div>
          )}

          {tab === 'members' && (
            <div className="space-y-3">
              <AddMemberPicker
                candidates={memberCandidates}
                onAdd={(userId, role) => addMemberMut.mutate({ userId, role })}
                pending={addMemberMut.isPending}
              />
              {members.map(m => (
                <div key={m.id} className="as-card flex items-center gap-3 p-3">
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium" style={{ color: 'var(--as-ink)' }}>{m.username}</span>
                    {m.org_path && <span className="text-xs ml-2" style={{ color: 'var(--as-ink-48)' }}>{m.org_path}</span>}
                  </div>
                  <select
                    value={m.is_tenant_admin ? 'tenant_admin' : 'user'}
                    onChange={e => setRoleMut.mutate({ userId: m.id, role: e.target.value as MemberRole })}
                    disabled={setRoleMut.isPending}
                    className="text-xs px-2 py-1 rounded-[var(--as-r-sm)] outline-none"
                    style={{ border: '1px solid var(--as-hairline)' }}
                  >
                    <option value="user">{t('tenants.detail.member.roleUser')}</option>
                    <option value="tenant_admin">{t('tenants.detail.member.roleTenantAdmin')}</option>
                  </select>
                  <button
                    onClick={() => { if (confirm(t('tenants.confirm.removeMember', { name: m.username }))) removeMemberMut.mutate(m.id) }}
                    className="as-btn as-btn-danger"
                  ><X size={13} /></button>
                </div>
              ))}
              {!members.length && <p className="text-sm" style={{ color: 'var(--as-ink-48)' }}>{t('tenants.detail.member.empty')}</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ResourceList({ title, emptyHint, items, selected, onToggle }: {
  title: string
  emptyHint: string
  items: { id: string; label: string }[]
  selected: string[]
  onToggle: (id: string) => void
}) {
  return (
    <div>
      <p className="as-caption mb-2" style={{ color: 'var(--as-ink-80)', fontWeight: 600 }}>{title}</p>
      <div className="space-y-1 max-h-32 overflow-y-auto rounded-[var(--as-r-sm)] p-2"
        style={{ border: '1px solid var(--as-hairline)' }}>
        {items.map(it => (
          <label key={it.id} className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={selected.includes(it.id)} onChange={() => onToggle(it.id)} style={{ accentColor: 'var(--as-primary)' }} />
            <span className="truncate">{it.label}</span>
          </label>
        ))}
        {!items.length && <p className="text-xs" style={{ color: 'var(--as-ink-48)' }}>{emptyHint}</p>}
      </div>
    </div>
  )
}

function AddMemberPicker({ candidates, onAdd, pending }: {
  candidates: { id: string; username: string }[]
  onAdd: (userId: string, role: MemberRole) => void
  pending: boolean
}) {
  const { t } = useTranslation()
  const [userId, setUserId] = useState('')
  const [role, setRole] = useState<MemberRole>('user')
  const submit = () => {
    if (!userId) return
    onAdd(userId, role)
    setUserId('')
  }
  if (!candidates.length) return null
  return (
    <div className="as-card p-3 flex items-center gap-2">
      <select value={userId} onChange={e => setUserId(e.target.value)} className="flex-1 text-sm rounded-[var(--as-r-sm)] px-2 py-1.5 outline-none" style={{ border: '1px solid var(--as-hairline)' }}>
        <option value="">{t('tenants.detail.member.selectUser')}</option>
        {candidates.map(u => <option key={u.id} value={u.id}>{u.username}</option>)}
      </select>
      <select value={role} onChange={e => setRole(e.target.value as MemberRole)} className="text-sm rounded-[var(--as-r-sm)] px-2 py-1.5 outline-none" style={{ border: '1px solid var(--as-hairline)' }}>
        <option value="user">{t('tenants.detail.member.roleUser')}</option>
        <option value="tenant_admin">{t('tenants.detail.member.roleTenantAdmin')}</option>
      </select>
      <button onClick={submit} disabled={!userId || pending} className="as-btn as-btn-primary as-btn-sm" style={{ opacity: (!userId || pending) ? 0.5 : 1 }}>
        {t('common.button.add')}
      </button>
    </div>
  )
}

function sameSet<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false
  const sa = new Set(a)
  for (const x of b) if (!sa.has(x)) return false
  return true
}
