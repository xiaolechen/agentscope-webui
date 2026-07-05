import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { Pencil, Trash2, Users as UsersIcon } from 'lucide-react'
import { tenantsApi, type Tenant } from '@/api/tenants'
import TenantDetailDialog from './TenantDetailDialog'

interface CreateFields {
  name: string
  display_name: string
}

export default function TenantsTab() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [editing, setEditing] = useState<Tenant | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const { register, handleSubmit, reset } = useForm<CreateFields>()

  const { data: tenants = [] } = useQuery({ queryKey: ['tenants'], queryFn: tenantsApi.list })

  const createMut = useMutation({
    mutationFn: (d: CreateFields) => tenantsApi.create({
      name: d.name,
      display_name: d.display_name || d.name,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tenants'] })
      setShowCreate(false); reset()
    },
  })
  const deleteMut = useMutation({
    mutationFn: (id: string) => tenantsApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tenants'] }),
  })

  const inputCls = 'w-full rounded-[var(--as-r-sm)] px-3 py-2 text-sm outline-none'
  const inputStyle = { border: '1px solid var(--as-hairline)' }

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 border-b flex items-center shrink-0"
        style={{ borderColor: 'var(--as-hairline)', height: 'var(--as-bar-h)', background: 'var(--as-parchment)' }}>
        <h2 className="text-lg font-semibold tracking-tight flex-1" style={{ color: 'var(--as-ink)' }}>{t('tenants.title')}</h2>
        <button onClick={() => { setShowCreate(true); reset() }} className="as-btn as-btn-primary as-btn-sm">
          {t('tenants.button.new')}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-2">
        {tenants.map(tn => (
          <div key={tn.id} className="as-card as-card-hover flex items-center gap-3 p-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium" style={{ color: 'var(--as-ink)' }}>{tn.display_name}</span>
                <span className="text-xs px-1.5 py-0.5 rounded-full font-medium" style={{ background: 'var(--as-parchment)', color: 'var(--as-ink-80)' }}>{tn.name}</span>
              </div>
              <p className="text-xs mt-1 flex items-center gap-3" style={{ color: 'var(--as-ink-48)' }}>
                <span className="inline-flex items-center gap-1"><UsersIcon size={11} />{t('tenants.card.members', { count: tn.member_count ?? 0 })}</span>
                <span>·</span>
                <span>{t('tenants.card.menus', { count: tn.menu_permissions.length })}</span>
              </p>
            </div>
            <div className="flex items-center gap-1">
              <button onClick={() => setEditing(tn)} className="as-btn as-btn-ghost" style={{ color: 'var(--as-primary)' }}><Pencil size={13} /></button>
              <button
                onClick={() => { if (confirm(t('tenants.confirm.delete', { name: tn.display_name }))) deleteMut.mutate(tn.id) }}
                className="as-btn as-btn-danger"><Trash2 size={13} /></button>
            </div>
          </div>
        ))}
        {!tenants.length && <p className="text-sm" style={{ color: 'var(--as-ink-48)' }}>{t('tenants.empty.noTenants')}</p>}
      </div>

      {showCreate && (
        <div className="as-overlay">
          <div className="as-dialog" style={{ maxWidth: 460 }}>
            <h3 className="text-base font-semibold mb-4">{t('tenants.dialog.new')}</h3>
            <form onSubmit={handleSubmit(d => createMut.mutate(d))} className="space-y-3">
              <div>
                <label className="as-caption" style={{ display: 'block', fontWeight: 500, color: 'var(--as-ink-80)', marginBottom: '6px' }}>
                  {t('tenants.form.name')}
                </label>
                <input {...register('name', { required: true, pattern: /^[A-Za-z0-9_-]+$/ })} placeholder={t('tenants.form.namePlaceholder')} className={inputCls} style={inputStyle} />
                <p className="as-micro mt-1" style={{ color: 'var(--as-ink-48)' }}>{t('tenants.form.nameHint')}</p>
              </div>
              <div>
                <label className="as-caption" style={{ display: 'block', fontWeight: 500, color: 'var(--as-ink-80)', marginBottom: '6px' }}>
                  {t('tenants.form.displayName')}
                </label>
                <input {...register('display_name')} placeholder={t('tenants.form.displayNamePlaceholder')} className={inputCls} style={inputStyle} />
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={() => { setShowCreate(false); reset() }} className="px-4 py-2 text-sm" style={{ color: 'var(--as-ink-80)' }}>{t('common.button.cancel')}</button>
                <button type="submit" className="px-4 py-2 text-white text-sm rounded-[var(--as-pill)]" style={{ background: 'var(--as-primary)' }}>
                  {t('common.button.create')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {editing && (
        <TenantDetailDialog
          tenantId={editing.id}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}
