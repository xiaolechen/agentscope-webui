import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { webuiApi, type KnowledgeBase, type KnowledgeBaseCreate } from '@/api/webui'
import { Trash2, ChevronRight, Pencil, BookOpen, Calendar, Folder } from 'lucide-react'

const PAGE = 8

type FormState = {
  name: string
  display_name: string
  path: string
  auto_update: boolean
  cron_expression: string
}

const EMPTY_FORM: FormState = {
  name: '',
  display_name: '',
  path: '',
  auto_update: false,
  cron_expression: '',
}

function fromKb(kb: KnowledgeBase): FormState {
  return {
    name: kb.name,
    display_name: kb.display_name ?? '',
    path: kb.path ?? '',
    auto_update: kb.auto_update ?? false,
    cron_expression: kb.cron_expression ?? '',
  }
}

export default function KnowledgePage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const qc = useQueryClient()

  const [showAdd, setShowAdd] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [page, setPage] = useState(0)

  const { data: kbs = [], isLoading } = useQuery({
    queryKey: ['knowledge-base'],
    queryFn: webuiApi.getKnowledgeBases,
  })

  const addMut = useMutation({
    mutationFn: () => webuiApi.addKnowledgeBase(formToCreate(form)),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['knowledge-base'] })
      closeDialog()
      // The backend auto-initializes via the llm-wiki-agent on creation. If the
      // agent isn't created yet, surface the prompt instead of a bare success.
      if (data.init && !data.init.ok) {
        if (data.init.error === 'agent_not_found') {
          alert(t('knowledge.detail.agentNotFound'))
        } else {
          alert(t('knowledge.detail.initFailed', { error: data.init.error ?? '' }))
        }
      } else if (data.init?.ok && data.init.session_id && data.name) {
        // Pin the init session as this KB's chat session so the 检索 tab resumes
        // it instead of creating a new one on first open. Matches the
        // `kb-session:<name>` localStorage key ChatPage reads in KB mode.
        localStorage.setItem(
          `kb-session:${data.name}`,
          JSON.stringify({ sessionId: data.init.session_id, agentId: data.init.agent_id ?? '' }),
        )
      }
    },
    onError: (err: unknown) => {
      const msg = (err as any)?.response?.data?.detail ?? (err instanceof Error ? err.message : '')
      alert(typeof msg === 'string' ? msg : JSON.stringify(msg))
    },
  })
  const updateMut = useMutation({
    mutationFn: () => webuiApi.updateKnowledgeBase(editing!, {
      display_name: form.display_name,
      auto_update: form.auto_update,
      cron_expression: form.cron_expression,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['knowledge-base'] }); closeDialog() },
  })
  const toggleMut = useMutation({
    mutationFn: ({ name, is_enabled }: { name: string; is_enabled: boolean }) =>
      webuiApi.toggleKnowledgeBase(name, is_enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['knowledge-base'] }),
  })
  const deleteMut = useMutation({
    mutationFn: (name: string) => webuiApi.deleteKnowledgeBase(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['knowledge-base'] }),
  })

  const closeDialog = () => {
    setShowAdd(false)
    setEditing(null)
    setForm(EMPTY_FORM)
  }

  const openCreate = () => {
    setForm(EMPTY_FORM)
    setEditing(null)
    setShowAdd(true)
  }

  const openEdit = (kb: KnowledgeBase) => {
    setForm(fromKb(kb))
    setEditing(kb.name)
    setShowAdd(true)
  }

  const saveMut = editing ? updateMut : addMut

  const setStr = (key: keyof FormState) =>
    (e: React.ChangeEvent<HTMLInputElement>) => setForm(prev => ({ ...prev, [key]: e.target.value }))

  const inputCls = "w-full rounded-[var(--as-r-sm)] px-3 py-2 text-sm outline-none"
  const inputStyle = { border: '1px solid var(--as-hairline)' }
  const labelCls = "text-xs font-medium mb-1 block"
  const labelStyle = { color: 'var(--as-ink-80)' }

  const list = kbs as KnowledgeBase[]
  const totalPages = Math.max(1, Math.ceil(list.length / PAGE))
  const paged = list.slice(page * PAGE, (page + 1) * PAGE)
  const formValid = !!form.name.trim()

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 border-b flex items-center shrink-0"
        style={{ borderColor: 'var(--as-hairline)', height: 'var(--as-bar-h)', background: 'var(--as-parchment)' }}>
        <h2 className="text-lg font-semibold tracking-tight flex-1" style={{ color: 'var(--as-ink)' }}>{t('knowledge.title')}</h2>
        <button onClick={openCreate} className="as-btn as-btn-primary as-btn-sm">{t('knowledge.button.create')}</button>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-2">
        {isLoading && <p className="text-sm" style={{ color: 'var(--as-ink-48)' }}>{t('common.status.loading')}</p>}
        {paged.map(kb => (
          <KbCard
            key={kb.name}
            kb={kb}
            onOpen={() => navigate(`/knowledge/${encodeURIComponent(kb.name)}`)}
            onToggleEnabled={(is_enabled) => toggleMut.mutate({ name: kb.name, is_enabled })}
            onEdit={() => openEdit(kb)}
            onDelete={() => {
              if (window.confirm(t('knowledge.deleteConfirm', { name: kb.name }))) deleteMut.mutate(kb.name)
            }}
          />
        ))}
        {!isLoading && !list.length && (
          <div className="flex flex-col items-center justify-center py-16 gap-3" style={{ color: 'var(--as-ink-48)' }}>
            <BookOpen size={32} />
            <p className="text-sm">{t('knowledge.empty.noDataHint')}</p>
            <button onClick={openCreate} className="as-btn as-btn-primary as-btn-sm">{t('knowledge.button.create')}</button>
          </div>
        )}
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
          <div className="as-dialog" style={{ minWidth: 480 }}>
            <h3 className="text-base font-semibold">
              {editing ? t('knowledge.dialog.edit') : t('knowledge.dialog.create')}
            </h3>

            <div>
              <label className={labelCls} style={labelStyle}>{t('knowledge.form.name')}</label>
              <input className={inputCls} style={inputStyle} placeholder={t('knowledge.form.namePlaceholder')}
                value={form.name} onChange={setStr('name')} disabled={!!editing} />
              {!editing && (
                <p className="text-xs mt-1" style={{ color: 'var(--as-ink-48)' }}>{t('knowledge.form.nameHint')}</p>
              )}
            </div>

            <div>
              <label className={labelCls} style={labelStyle}>{t('knowledge.form.displayName')}</label>
              <input className={inputCls} style={inputStyle} placeholder={t('knowledge.form.displayNamePlaceholder')}
                value={form.display_name} onChange={setStr('display_name')} />
            </div>

            {!editing && (
              <div>
                <label className={labelCls} style={labelStyle}>{t('knowledge.form.path')}</label>
                <input className={inputCls} style={inputStyle} placeholder={t('knowledge.form.pathPlaceholder')}
                  value={form.path} onChange={setStr('path')} />
                <p className="text-xs mt-1" style={{ color: 'var(--as-ink-48)' }}>{t('knowledge.form.pathHint')}</p>
              </div>
            )}

            <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--as-ink-80)' }}>
              <input type="checkbox" checked={form.auto_update}
                onChange={e => setForm(prev => ({ ...prev, auto_update: e.target.checked }))}
                style={{ accentColor: 'var(--as-primary)' }} />
              {t('knowledge.form.autoUpdate')}
            </label>

            {form.auto_update && (
              <div>
                <label className={labelCls} style={labelStyle}>{t('knowledge.form.cronExpression')}</label>
                <input className={inputCls} style={inputStyle} placeholder="0 2 * * *"
                  value={form.cron_expression} onChange={setStr('cron_expression')} />
                <p className="text-xs mt-1" style={{ color: 'var(--as-ink-48)' }}>{t('knowledge.form.cronHint')}</p>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button onClick={closeDialog} className="px-4 py-2 text-sm" style={{ color: 'var(--as-ink-80)' }}>{t('common.button.cancel')}</button>
              <button onClick={() => saveMut.mutate()} disabled={!formValid || saveMut.isPending}
                className="as-btn as-btn-primary">
                {saveMut.isPending ? t('common.status.saving') : t('common.button.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function formToCreate(form: FormState): KnowledgeBaseCreate {
  return {
    name: form.name.trim(),
    display_name: form.display_name.trim(),
    path: form.path.trim(),
    auto_update: form.auto_update,
    cron_expression: form.cron_expression.trim(),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Card
// ─────────────────────────────────────────────────────────────────────────────

interface KbCardProps {
  kb: KnowledgeBase
  onOpen: () => void
  onToggleEnabled: (is_enabled: boolean) => void
  onEdit: () => void
  onDelete: () => void
}

function KbCard({ kb, onOpen, onToggleEnabled, onEdit, onDelete }: KbCardProps) {
  const { t } = useTranslation()
  return (
    <div className="as-card as-card-hover overflow-hidden">
      <div className="flex items-center gap-3 p-4 cursor-pointer" onClick={onOpen}>
        <button
          onClick={e => { e.stopPropagation(); onToggleEnabled(!kb.is_enabled) }}
          className="shrink-0 px-2.5 py-0.5 rounded-full text-xs font-medium transition-colors"
          style={kb.is_enabled
            ? { background: 'var(--as-primary)', color: '#fff' }
            : { background: 'var(--as-hairline)', color: 'var(--as-ink-48)' }}>
          {kb.is_enabled ? t('knowledge.badge.enabled') : t('knowledge.badge.disabled')}
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium" style={{ color: 'var(--as-ink)' }}>
            {kb.display_name || kb.name}
          </p>
          <p className="text-xs truncate mt-0.5 flex items-center gap-1" style={{ color: 'var(--as-ink-48)' }}>
            <Folder size={11} /> {kb.path}
          </p>
          {kb.auto_update && (
            <p className="text-xs mt-0.5 flex items-center gap-1" style={{ color: 'var(--as-ink-48)' }}>
              <Calendar size={11} /> {t('knowledge.form.autoUpdate')}: {kb.cron_expression}
            </p>
          )}
        </div>
        <ChevronRight size={16} className="shrink-0" style={{ color: 'var(--as-ink-48)' }} />
        <button onClick={e => { e.stopPropagation(); onEdit() }} className="as-btn as-btn-ghost as-btn-sm" style={{ padding: '4px' }} title={t('common.button.edit')}>
          <Pencil size={13} />
        </button>
        <button onClick={e => { e.stopPropagation(); onDelete() }} className="as-btn as-btn-danger"><Trash2 size={13} /></button>
      </div>
    </div>
  )
}
