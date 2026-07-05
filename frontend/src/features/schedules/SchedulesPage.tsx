import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/store/auth'
import { schedulesApi } from '@/api/schedules'
import { agentsApi } from '@/api/agents'
import { webuiApi } from '@/api/webui'
import { useForm } from 'react-hook-form'
import { Play, Trash2 } from 'lucide-react'

const PAGE = 8

const TIMEZONES = [
  'UTC',
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Taipei',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Asia/Seoul',
  'Asia/Kolkata',
  'Asia/Dubai',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Moscow',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Australia/Sydney',
  'Pacific/Auckland',
]

export default function SchedulesPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const role = useAuthStore(s => s.role)
  const boundAgentIds = useAuthStore(s => s.boundAgentIds)
  const [showAdd, setShowAdd] = useState(false)
  const [page, setPage] = useState(0)
  const { data: schedules = [] } = useQuery({ queryKey: ['schedules'], queryFn: schedulesApi.list })
  const { data: agents = [] } = useQuery({ queryKey: ['agents'], queryFn: agentsApi.list })
  // Non-admins can only schedule agents they can access (mirrors SessionsPage).
  const createableAgents: any[] = role === 'admin'
    ? (agents as any[])
    : (agents as any[]).filter(a => boundAgentIds.includes(a.id))
  const { register, handleSubmit, reset } = useForm({
    defaultValues: {
      agent_id: '',
      name: '',
      description: '',
      cron_expression: '0 9 * * 1-5',
      timezone: 'Asia/Shanghai',
    },
  })

  const createMut = useMutation({
    mutationFn: (data: any) => webuiApi.createSchedule({
      name: data.name,
      description: data.description ?? '',
      cron_expression: data.cron_expression,
      timezone: data.timezone || 'UTC',
      agent_id: data.agent_id,
      enabled: true,
      stateful: false,
      permission_mode: 'dont_ask',
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['schedules'] }); setShowAdd(false); reset() },
  })
  const deleteMut = useMutation({
    mutationFn: (id: string) => schedulesApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['schedules'] }),
  })
  const toggleMut = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => schedulesApi.update(id, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['schedules'] }),
  })
  const runMut = useMutation({
    mutationFn: (id: string) => schedulesApi.runNow(id),
    onSuccess: (data: any) => {
      if (!data?.agent_id || !data?.prompt) return
      sessionStorage.setItem('runSchedule', JSON.stringify({
        agentId: data.agent_id,
        prompt: data.prompt,
      }))
      navigate('/chat')
    },
  })

  const inputCls = "w-full rounded-[var(--as-r-sm)] px-3 py-2 text-sm outline-none"
  const inputStyle = { border: '1px solid var(--as-hairline)' }
  const Label = ({ text }: { text: string }) => (
    <label className="block text-xs font-medium mb-1" style={{ color: 'var(--as-ink-80)' }}>{text}</label>
  )

  const list = schedules as any[]
  const totalPages = Math.max(1, Math.ceil(list.length / PAGE))
  const paged = list.slice(page * PAGE, (page + 1) * PAGE)

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 border-b flex items-center shrink-0" style={{ borderColor: 'var(--as-hairline)', height: 'var(--as-bar-h)', background: 'var(--as-parchment)' }}>
        <h2 className="text-lg font-semibold tracking-tight flex-1" style={{ color: 'var(--as-ink)' }}>{t('schedules.title')}</h2>
        <button onClick={() => setShowAdd(true)} className="as-btn as-btn-primary as-btn-sm">{t('schedules.button.new')}</button>
      </div>
      <div className="flex-1 overflow-y-auto p-6 space-y-2">
        {paged.map((sch: any) => {
          const enabled = sch.data?.enabled ?? false
          return (
          <div key={sch.id} className="as-card as-card-hover flex items-center gap-3 p-4">
            <button
              onClick={() => toggleMut.mutate({ id: sch.id, enabled: !enabled })}
              className="shrink-0 px-2.5 py-0.5 rounded-full text-xs font-medium transition-colors"
              style={enabled
                ? { background: 'var(--as-primary)', color: '#fff' }
                : { background: 'var(--as-hairline)', color: 'var(--as-ink-48)' }}>
              {enabled ? t('schedules.badge.enabled') : t('schedules.badge.disabled')}
            </button>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium" style={{ color: 'var(--as-ink)' }}>{sch.data?.name}</p>
              <p className="text-xs font-mono mt-0.5" style={{ color: 'var(--as-ink-48)' }}>{sch.data?.cron_expression} · {sch.data?.timezone}</p>
              <p className="text-xs mt-0.5" style={{ color: 'var(--as-ink-48)' }}>{(agents as any[]).find((a: any) => a.id === sch.agent_id)?.data.name}</p>
            </div>
            <div className="flex items-center gap-1">
              <button onClick={() => runMut.mutate(sch.id)} disabled={runMut.isPending}
                className="flex items-center gap-1 px-2 py-1 text-xs rounded-[var(--as-r-sm)] disabled:opacity-50"
                style={{ color: 'var(--as-primary)', border: '1px solid var(--as-primary)' }}
                title={t('schedules.button.runNowTitle')}>
                <Play size={11} /> {t('schedules.button.run')}
              </button>
              <button onClick={() => { if (confirm(t('schedules.confirm.delete'))) deleteMut.mutate(sch.id) }} className="as-btn as-btn-danger"><Trash2 size={13} /></button>
            </div>
          </div>
          )
        })}
        {!list.length && <p className="text-sm" style={{ color: 'var(--as-ink-48)' }}>{t('schedules.empty.noSchedules')}</p>}
      </div>

      {list.length > PAGE && (
        <div className="px-6 border-t flex items-center gap-3 shrink-0"
          style={{ borderColor: 'var(--as-hairline)', height: 'var(--as-footer-bar-h)', background: 'var(--as-parchment)' }}>
          <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
            className="text-xs px-2 py-1 border rounded disabled:opacity-40" style={{ borderColor: 'var(--as-hairline)' }}>{t('common.pagination.prev')}</button>
          <span className="text-xs" style={{ color: 'var(--as-ink-48)' }}>{page + 1} / {totalPages}</span>
          <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
            className="text-xs px-2 py-1 border rounded disabled:opacity-40" style={{ borderColor: 'var(--as-hairline)' }}>{t('common.pagination.next')}</button>
          <span className="text-xs ml-auto" style={{ color: 'var(--as-ink-48)' }}>{t('common.pagination.total', { count: list.length })}</span>
        </div>
      )}

      {showAdd && (
        <div className="as-overlay">
          <div className="as-dialog">
            <h3 className="text-base font-semibold mb-1">{t('schedules.dialog.new')}</h3>
            <p className="text-xs mb-4" style={{ color: 'var(--as-ink-48)' }}>{t('schedules.dialog.modelHint')}</p>
            <form onSubmit={handleSubmit(data => createMut.mutate(data))} className="space-y-3">
              <div>
                <Label text={t('schedules.form.agent')} />
                <select {...register('agent_id', { required: true })} className={inputCls} style={inputStyle}>
                  <option value="">{t('schedules.form.selectAgent')}</option>
                  {createableAgents.map((a: any) => <option key={a.id} value={a.id}>{a.data.name}</option>)}
                </select>
              </div>

              <div>
                <Label text={t('schedules.form.name')} />
                <input {...register('name', { required: true })} placeholder={t('schedules.form.namePlaceholder')} className={inputCls} style={inputStyle} />
              </div>

              <div>
                <Label text={t('schedules.form.description')} />
                <input {...register('description')} placeholder={t('schedules.form.descriptionPlaceholder')} className={inputCls} style={inputStyle} />
              </div>

              <div>
                <Label text={t('schedules.form.cronExpression')} />
                <input {...register('cron_expression', { required: true })}
                  className={`${inputCls} font-mono`} style={inputStyle} />
                <p className="text-[10px] mt-1" style={{ color: 'var(--as-ink-48)' }}>
                  {t('schedules.form.cronHelp')}
                </p>
              </div>

              <div>
                <Label text={t('schedules.form.timezone')} />
                <select {...register('timezone')} className={inputCls} style={inputStyle}>
                  {TIMEZONES.map(tz => <option key={tz} value={tz}>{tz}</option>)}
                </select>
              </div>

              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={() => { setShowAdd(false); reset() }}
                  className="as-btn as-btn-sm" style={{ color: 'var(--as-ink-80)', border: '1px solid var(--as-hairline)' }}>
                  {t('common.button.cancel')}
                </button>
                <button type="submit" disabled={createMut.isPending} className="as-btn as-btn-primary as-btn-sm">
                  {createMut.isPending ? t('common.status.saving') : t('common.button.save')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
