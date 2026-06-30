import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { usersApi } from '@/api/users'
import { agentsApi } from '@/api/agents'
import { useForm } from 'react-hook-form'
import { Pencil, Trash2 } from 'lucide-react'

const PAGE = 10

export default function UsersPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [dialog, setDialog] = useState<'create' | any | null>(null)
  const [selectedAgents, setSelectedAgents] = useState<string[]>([])
  const [page, setPage] = useState(0)
  const { data: users = [] } = useQuery({ queryKey: ['users'], queryFn: usersApi.list })
  const { data: agents = [] } = useQuery({ queryKey: ['agents'], queryFn: agentsApi.list })
  const { register, handleSubmit, reset } = useForm()

  const isEditing = dialog && dialog !== 'create'

  const openEdit = (user: any) => {
    setDialog(user)
    setSelectedAgents(user.bound_agent_ids ?? [])
    reset({ password: '', role: user.role ?? 'user' })
  }

  const openCreate = () => { setDialog('create'); setSelectedAgents([]); reset() }
  const close = () => { setDialog(null); setSelectedAgents([]) }

  const toggleAgent = (id: string) =>
    setSelectedAgents(prev => prev.includes(id) ? prev.filter(a => a !== id) : [...prev, id])

  const createMut = useMutation({
    mutationFn: (d: any) => usersApi.create({ ...d, bound_agent_ids: selectedAgents }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['users'] }); close() },
  })
  const updateMut = useMutation({
    mutationFn: (d: any) => usersApi.update(dialog.id, { role: d.role, bound_agent_ids: selectedAgents, ...(d.password ? { password: d.password } : {}) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['users'] }); close() },
  })
  const deleteMut = useMutation({
    mutationFn: (id: string) => usersApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  })

  const inputCls = "w-full rounded-[var(--as-r-sm)] px-3 py-2 text-sm outline-none"
  const inputStyle = { border: '1px solid var(--as-hairline)' }

  const totalPages = Math.max(1, Math.ceil((users as any[]).length / PAGE))
  const paged = (users as any[]).slice(page * PAGE, (page + 1) * PAGE)

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 border-b flex items-center shrink-0" style={{ borderColor: 'var(--as-hairline)', height: 'var(--as-bar-h)', background: 'var(--as-parchment)' }}>
        <h2 className="text-lg font-semibold tracking-tight flex-1" style={{ color: 'var(--as-ink)' }}>{t('users.title')}</h2>
        <button onClick={openCreate} className="as-btn as-btn-primary as-btn-sm">
          {t('users.button.new')}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-2">
        {paged.map((user: any) => (
          <div key={user.id} className="as-card as-card-hover flex items-center gap-3 p-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium" style={{ color: 'var(--as-ink)' }}>{user.username}</span>
                <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${user.role === 'admin' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>{user.role}</span>
              </div>
              {user.bound_agent_ids?.length > 0 && (
                <p className="text-xs mt-1 truncate" style={{ color: 'var(--as-ink-48)' }}>
                  {t('users.card.agents')}{user.bound_agent_ids.map((id: string) => (agents as any[]).find((a: any) => a.id === id)?.data.name ?? id.slice(0, 8)).join(', ')}
                </p>
              )}
            </div>
            <div className="flex items-center gap-1">
              <button onClick={() => openEdit(user)} className="as-btn as-btn-ghost" style={{ color: "var(--as-primary)" }}><Pencil size={13} /></button>
              <button onClick={() => { if (confirm(t('users.confirm.delete', { name: user.username }))) deleteMut.mutate(user.id) }} className="as-btn as-btn-danger"><Trash2 size={13} /></button>
            </div>
          </div>
        ))}
        {!(users as any[]).length && <p className="text-sm" style={{ color: 'var(--as-ink-48)' }}>{t('users.empty.noUsers')}</p>}
      </div>

      {(users as any[]).length > PAGE && (
        <div className="px-6 border-t flex items-center gap-3 shrink-0"
          style={{ borderColor: 'var(--as-hairline)', height: 'var(--as-footer-bar-h)', background: 'var(--as-parchment)' }}>
          <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
            className="text-xs px-2 py-1 border rounded disabled:opacity-40" style={{ borderColor: 'var(--as-hairline)' }}>{t('common.pagination.prev')}</button>
          <span className="text-xs" style={{ color: 'var(--as-ink-48)' }}>{page + 1} / {totalPages}</span>
          <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
            className="text-xs px-2 py-1 border rounded disabled:opacity-40" style={{ borderColor: 'var(--as-hairline)' }}>{t('common.pagination.next')}</button>
          <span className="text-xs ml-auto" style={{ color: 'var(--as-ink-48)' }}>{t('common.pagination.total', { count: (users as any[]).length })}</span>
        </div>
      )}

      {dialog && (
        <div className="as-overlay">
          <div className="as-dialog">
            <h3 className="text-base font-semibold mb-4">{isEditing ? t('users.dialog.edit', { name: dialog.username }) : t('users.dialog.new')}</h3>
            <form onSubmit={handleSubmit(d => isEditing ? updateMut.mutate(d) : createMut.mutate(d))} className="space-y-3">
              {!isEditing && <input {...register('username', { required: true })} placeholder={t('users.form.usernamePlaceholder')} className={inputCls} style={inputStyle} />}
              <input {...register('password')} type="password" placeholder={isEditing ? t('users.form.passwordPlaceholderEdit') : t('users.form.passwordPlaceholder')} className={inputCls} style={inputStyle} />
              <select {...register('role')} className={inputCls} style={inputStyle}>
                <option value="user">{t('users.form.roleUser')}</option>
                <option value="admin">{t('users.form.roleAdmin')}</option>
              </select>
              <div>
                <p className="text-xs font-medium mb-2" style={{ color: 'var(--as-ink-80)' }}>{t('users.form.boundAgents')}</p>
                <div className="space-y-1 max-h-36 overflow-y-auto rounded-[var(--as-r-sm)] p-2" style={{ border: '1px solid var(--as-hairline)' }}>
                  {(agents as any[]).map((a: any) => (
                    <label key={a.id} className="flex items-center gap-2 text-sm cursor-pointer">
                      <input type="checkbox" checked={selectedAgents.includes(a.id)} onChange={() => toggleAgent(a.id)} style={{ accentColor: 'var(--as-primary)' }} />
                      {a.data.name}
                    </label>
                  ))}
                  {!(agents as any[]).length && <p className="text-xs" style={{ color: 'var(--as-ink-48)' }}>{t('users.form.emptyAgents')}</p>}
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={close} className="px-4 py-2 text-sm" style={{ color: 'var(--as-ink-80)' }}>{t('common.button.cancel')}</button>
                <button type="submit" className="px-4 py-2 text-white text-sm rounded-[var(--as-pill)]" style={{ background: 'var(--as-primary)' }}>
                  {isEditing ? t('common.button.save') : t('common.button.create')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
