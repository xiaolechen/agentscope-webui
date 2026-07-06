import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { Pencil, Trash2, SlidersHorizontal } from 'lucide-react'
import { usersApi, type UserRecord, type UserRole } from '@/api/users'
import { agentsApi } from '@/api/agents'
import { tenantsApi, type Tenant } from '@/api/tenants'
import { useAuthStore } from '@/store/auth'
import MemberResourcesDialog from './MemberResourcesDialog'

const PAGE = 10

const ROLE_BADGE: Record<UserRole, string> = {
  admin: 'bg-blue-100 text-blue-700',
  tenant_admin: 'bg-purple-100 text-purple-700',
  user: 'bg-gray-100 text-gray-600',
}

interface FormFields {
  username?: string
  password?: string
  role: UserRole
  tenant_id: string
}

export default function UsersTab() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const role = useAuthStore(s => s.role)
  const currentUserId = useAuthStore(s => s.userId)
  const [dialog, setDialog] = useState<UserRecord | 'create' | null>(null)
  const [selectedAgents, setSelectedAgents] = useState<string[]>([])
  const [page, setPage] = useState(0)
  const [resourcesFor, setResourcesFor] = useState<UserRecord | null>(null)

  const { data: users = [] } = useQuery({ queryKey: ['users'], queryFn: usersApi.list })
  const { data: agents = [] } = useQuery({ queryKey: ['agents'], queryFn: agentsApi.list })
  // Only super-admins can enumerate all tenants (admin-only endpoint).
  const { data: tenants = [] } = useQuery({
    queryKey: ['tenants'], queryFn: tenantsApi.list, enabled: role === 'admin',
  })
  // Non-admins fetch their own tenant to filter the bound-agent picker to the
  // tenant's assigned_agents (the backend enforces this subset on write).
  const { data: myTenant } = useQuery({
    queryKey: ['my-tenant'], queryFn: tenantsApi.getMyTenant, enabled: role !== 'admin',
  })
  const { register, handleSubmit, reset, watch } = useForm<FormFields>()

  const isEditing = dialog && dialog !== 'create'
  const watchedRole = watch('role')
  const isAdmin = role === 'admin'
  // Editing one's own record: a regular user may only change their password;
  // a tenant_admin may not change their own role. isEditing already guarantees
  // dialog is a UserRecord (not 'create' / null).
  const isSelf = !!isEditing && !!currentUserId &&
    (dialog as UserRecord | null)?.id === currentUserId
  // Role field is mutable only by admins, or by tenant_admins editing someone
  // other than themselves.
  const canChangeRole = isAdmin || !isSelf
  // A regular member editing themselves sees password only — no role picker.
  const showRoleSelect = !(role === 'user' && isSelf)

  // Bound-agent picker candidates: admins see all agents; tenant_admins only
  // see their tenant's assigned_agents (others would be rejected on save).
  const pickerAgents = isAdmin
    ? agents
    : agents.filter(a => (myTenant?.assigned_agents ?? []).includes(a.id))

  // tenant_admin creating a regular user must assign an agent subset inline.
  // (mcps/skills are intentionally not configured per-user for now; the
  // tenant pool still applies, and existing values are preserved on save.)
  const showResourceSection = !isAdmin && !isEditing && watchedRole === 'user'

  const tenantName = (tid: string | null) =>
    tid ? (tenants as Tenant[]).find(t => t.id === tid)?.display_name
      ?? (myTenant?.id === tid ? myTenant.display_name : null)
      ?? tid : null

  const openEdit = (user: UserRecord) => {
    setDialog(user)
    setSelectedAgents(user.bound_agent_ids ?? [])
    reset({ password: '', role: user.role, tenant_id: user.tenant_id ?? '' })
  }
  const openCreate = () => {
    setDialog('create')
    setSelectedAgents([])
    reset({ role: 'user', tenant_id: '' })
  }
  const close = () => { setDialog(null); setSelectedAgents([]) }

  const toggle = (setter: React.Dispatch<React.SetStateAction<string[]>>, id: string) =>
    setter(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])

  const createMut = useMutation({
    mutationFn: (d: FormFields) => usersApi.create({
      username: d.username!,
      password: d.password!,
      role: d.role,
      bound_agent_ids: selectedAgents,
      // admin role cannot belong to a tenant; non-admins must NOT send a
      // tenant_id (the backend forces it to the caller's own tenant).
      tenant_id: !isAdmin ? undefined : (d.role === 'admin' ? null : (d.tenant_id || null)),
      // tenant_admin creating a regular user sends the per-user agent subset;
      // mcps/skills are not configured per-user for now (sent empty — the
      // tenant pool still governs them). Ignored on the admin path and for
      // tenant_admin role.
      resources: showResourceSection
        ? { agents: selectedAgents, mcps: [], skills: [] }
        : undefined,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['users'] }); close() },
  })
  const updateMut = useMutation({
    mutationFn: (d: FormFields) => usersApi.update((dialog as UserRecord).id, {
      // A regular user editing themselves sends password only — the backend
      // rejects any other field for role='user' on self. Role/tenant changes
      // are admin/tenant_admin concerns.
      ...(role === 'user' && isSelf ? {} : { role: d.role }),
      // bound_agent_ids is intentionally not sent on edit: resource assignment
      // for existing users is done via the per-member Resources dialog, and
      // admins don't manage agent bindings at all.
      ...(d.password ? { password: d.password } : {}),
      tenant_id: !isAdmin ? undefined : (d.role === 'admin' ? null : (d.tenant_id || null)),
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['users'] }); close() },
  })
  const deleteMut = useMutation({
    mutationFn: (id: string) => usersApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  })

  const inputCls = 'w-full rounded-[var(--as-r-sm)] px-3 py-2 text-sm outline-none'
  const inputStyle = { border: '1px solid var(--as-hairline)' }
  const listCls = 'space-y-1 max-h-36 overflow-y-auto rounded-[var(--as-r-sm)] p-2'
  const listStyle = { border: '1px solid var(--as-hairline)' }

  const totalPages = Math.max(1, Math.ceil(users.length / PAGE))
  const paged = users.slice(page * PAGE, (page + 1) * PAGE)

  // Disable submit when tenant_admin creates a user with no agents selected.
  const createDisabled = !!createMut.isPending || (showResourceSection && selectedAgents.length === 0)

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 border-b flex items-center shrink-0" style={{ borderColor: 'var(--as-hairline)', height: 'var(--as-bar-h)', background: 'var(--as-parchment)' }}>
        <h2 className="text-lg font-semibold tracking-tight flex-1" style={{ color: 'var(--as-ink)' }}>{t('users.title')}</h2>
        {/* Only admins/tenant_admins create users. Members (role='user') land on
            this page only to view their own record — never to manage users. */}
        {(role === 'admin' || role === 'tenant_admin') && (
          <button onClick={openCreate} className="as-btn as-btn-primary as-btn-sm">
            {t('users.button.new')}
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-2">
        {paged.map((user) => {
          const tn = tenantName(user.tenant_id)
          const isSelfRow = user.id === currentUserId
          // Edit: admins edit anyone; tenant_admins edit their tenant members;
          // a regular member may edit only their own record (password only).
          const canEditRow = isAdmin || role === 'tenant_admin' || isSelfRow
          // Delete: admins/tenant_admins may delete others, never themselves;
          // regular members cannot delete anyone.
          const canDeleteRow = (isAdmin || role === 'tenant_admin') && !isSelfRow
          return (
            <div key={user.id} className="as-card as-card-hover flex items-center gap-3 p-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium" style={{ color: 'var(--as-ink)' }}>{user.username}</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${ROLE_BADGE[user.role]}`}>{user.role}</span>
                  {tn && <span className="text-xs px-1.5 py-0.5 rounded-full font-medium" style={{ background: 'var(--as-parchment)', color: 'var(--as-ink-80)' }}>{tn}</span>}
                </div>
                {user.bound_agent_ids?.length > 0 && (
                  <p className="text-xs mt-1 truncate" style={{ color: 'var(--as-ink-48)' }}>
                    {t('users.card.agents')}{user.bound_agent_ids.map((id) => agents.find(a => a.id === id)?.data.name ?? id.slice(0, 8)).join(', ')}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1">
                {/* Tenant admins can assign per-user agents from the tenant
                    pool. Super-admins do this from the Tenants tab; tenant_admin
                    users inherit the full pool so they don't need assignment. */}
                {role === 'tenant_admin' && user.role === 'user' && user.tenant_id && (
                  <button
                    onClick={() => setResourcesFor(user)}
                    className="as-btn as-btn-ghost"
                    title={t('users.button.resources')}
                    style={{ color: 'var(--as-ink-80)' }}
                  ><SlidersHorizontal size={13} /></button>
                )}
                {canEditRow && (
                  <button onClick={() => openEdit(user)} className="as-btn as-btn-ghost" style={{ color: 'var(--as-primary)' }}><Pencil size={13} /></button>
                )}
                {canDeleteRow && (
                  <button onClick={() => { if (confirm(t('users.confirm.delete', { name: user.username }))) deleteMut.mutate(user.id) }} className="as-btn as-btn-danger"><Trash2 size={13} /></button>
                )}
              </div>
            </div>
          )
        })}
        {!users.length && <p className="text-sm" style={{ color: 'var(--as-ink-48)' }}>{t('users.empty.noUsers')}</p>}
      </div>

      {users.length > PAGE && (
        <div className="px-6 border-t flex items-center gap-3 shrink-0"
          style={{ borderColor: 'var(--as-hairline)', height: 'var(--as-footer-bar-h)', background: 'var(--as-parchment)' }}>
          <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
            className="text-xs px-2 py-1 border rounded disabled:opacity-40" style={{ borderColor: 'var(--as-hairline)' }}>{t('common.pagination.prev')}</button>
          <span className="text-xs" style={{ color: 'var(--as-ink-48)' }}>{page + 1} / {totalPages}</span>
          <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
            className="text-xs px-2 py-1 border rounded disabled:opacity-40" style={{ borderColor: 'var(--as-hairline)' }}>{t('common.pagination.next')}</button>
          <span className="text-xs ml-auto" style={{ color: 'var(--as-ink-48)' }}>{t('common.pagination.total', { count: users.length })}</span>
        </div>
      )}

      {dialog && (
        <div className="as-overlay">
          <div className="as-dialog" style={{ maxWidth: 480 }}>
            <h3 className="text-base font-semibold mb-4">{isEditing ? t('users.dialog.edit', { name: (dialog as UserRecord).username }) : t('users.dialog.new')}</h3>
            <form onSubmit={handleSubmit(d => isEditing ? updateMut.mutate(d) : createMut.mutate(d))} className="space-y-3">
              {!isEditing && <input {...register('username', { required: true })} placeholder={t('users.form.usernamePlaceholder')} className={inputCls} style={inputStyle} />}
              <input {...register('password')} type="password" placeholder={isEditing ? t('users.form.passwordPlaceholderEdit') : t('users.form.passwordPlaceholder')} className={inputCls} style={inputStyle} />
              {showRoleSelect && (
                <select {...register('role')} disabled={!canChangeRole} className={inputCls} style={inputStyle}>
                  <option value="user">{t('users.form.roleUser')}</option>
                  <option value="tenant_admin">{t('users.form.roleTenantAdmin')}</option>
                  {isAdmin && <option value="admin">{t('users.form.roleAdmin')}</option>}
                </select>
              )}
              {isAdmin && watchedRole !== 'admin' && (
                <div>
                  <label className="as-caption" style={{ display: 'block', fontWeight: 500, color: 'var(--as-ink-80)', marginBottom: '6px' }}>
                    {t('users.form.tenant')}
                  </label>
                  <select {...register('tenant_id')} className={inputCls} style={inputStyle}>
                    <option value="">{t('users.form.noTenant')}</option>
                    {tenants.map(tn => <option key={tn.id} value={tn.id}>{tn.display_name}</option>)}
                  </select>
                  {watchedRole === 'tenant_admin' && (
                    <p className="as-micro mt-1" style={{ color: 'var(--as-ink-48)' }}>{t('users.form.tenantAdminRequiresTenant')}</p>
                  )}
                  <p className="as-micro mt-1" style={{ color: 'var(--as-ink-48)' }}>{t('users.form.resourcesLockedHint')}</p>
                </div>
              )}
              {!isAdmin && (
                <p className="as-micro" style={{ color: 'var(--as-ink-48)' }}>
                  {t('users.form.tenantScopedHint', { name: myTenant?.display_name ?? '' })}
                </p>
              )}

              {showResourceSection && (
                <div className="space-y-3">
                  <div>
                    <p className="text-xs font-medium mb-1" style={{ color: 'var(--as-ink-80)' }}>{t('users.form.resourcesSection')}</p>
                    <p className="as-micro mb-2" style={{ color: 'var(--as-ink-48)' }}>{t('users.form.resourcesHint')}</p>
                  </div>
                  <div>
                    <p className="text-xs font-medium mb-1" style={{ color: 'var(--as-ink-80)' }}>{t('tenants.detail.resources.agents')}</p>
                    <div className={listCls} style={listStyle}>
                      {pickerAgents.map(a => (
                        <label key={a.id} className="flex items-center gap-2 text-sm cursor-pointer">
                          <input type="checkbox" checked={selectedAgents.includes(a.id)} onChange={() => toggle(setSelectedAgents, a.id)} style={{ accentColor: 'var(--as-primary)' }} />
                          {a.data.name}
                        </label>
                      ))}
                      {!pickerAgents.length && <p className="text-xs" style={{ color: 'var(--as-ink-48)' }}>{t('users.form.emptyAgents')}</p>}
                    </div>
                  </div>
                </div>
              )}
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={close} className="px-4 py-2 text-sm" style={{ color: 'var(--as-ink-80)' }}>{t('common.button.cancel')}</button>
                <button type="submit" disabled={isEditing ? updateMut.isPending : createDisabled}
                  className="px-4 py-2 text-white text-sm rounded-[var(--as-pill)] disabled:opacity-50" style={{ background: 'var(--as-primary)' }}>
                  {isEditing ? t('common.button.save') : t('common.button.create')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {resourcesFor && resourcesFor.tenant_id && (
        <MemberResourcesDialog
          tenantId={resourcesFor.tenant_id}
          userId={resourcesFor.id}
          username={resourcesFor.username}
          onClose={() => setResourcesFor(null)}
        />
      )}
    </div>
  )
}
