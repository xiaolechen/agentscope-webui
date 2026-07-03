import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { webuiApi, type SkillDef } from '@/api/webui'
import { useAuthStore } from '@/store/auth'
import { Search, Loader2, CheckCircle2, XCircle, Eye, Pencil, Save, X } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const PAGE = 10

interface InstallResult {
  ok: boolean
  stdout?: string
  stderr?: string
  skills?: { name: string; path: string }[]
  error?: string
}

export default function SkillsPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const role = useAuthStore(s => s.role)
  const isAdmin = role === 'admin'

  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [showAdd, setShowAdd] = useState(false)
  const [command, setCommand] = useState('')
  const [targetDir, setTargetDir] = useState('')
  const [result, setResult] = useState<InstallResult | null>(null)
  const [previewSkill, setPreviewSkill] = useState<SkillDef | null>(null)

  const { data: skills = [], isLoading } = useQuery({ queryKey: ['skill-lib'], queryFn: webuiApi.getSkillLib })
  const { data: skillDirs = [] } = useQuery({
    queryKey: ['skill-dirs'],
    queryFn: webuiApi.getSkillDirs,
    enabled: isAdmin,  // only admins see the install dialog
  })

  // Default-select the only registered dir; clear when dialog closes.
  const dirs = skillDirs as string[]
  const effectiveTarget = targetDir || (dirs.length === 1 ? dirs[0] : '')

  const installMut = useMutation({
    mutationFn: () => webuiApi.installSkill(command, effectiveTarget),
    onSuccess: (data) => {
      setResult(data)
      if (data.ok) qc.invalidateQueries({ queryKey: ['skill-lib'] })
    },
    onError: (err: unknown) => setResult({
      ok: false,
      error: err instanceof Error ? err.message : t('common.error.requestFailed'),
    }),
  })

  const openDialog = () => {
    setCommand('')
    setTargetDir('')
    setResult(null)
    installMut.reset()
    setShowAdd(true)
  }
  const closeDialog = () => {
    setShowAdd(false)
    setResult(null)
    installMut.reset()
  }

  const canInstall = !!command.trim() && !!effectiveTarget && !installMut.isPending

  const filtered = (skills as { name: string; path: string; is_enabled: boolean }[]).filter((s) =>
    s.name.toLowerCase().includes(search.toLowerCase()) ||
    s.path.toLowerCase().includes(search.toLowerCase())
  )
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE))
  const paged = filtered.slice(page * PAGE, (page + 1) * PAGE)

  const inputCls = "w-full rounded-[var(--as-r-sm)] px-3 py-2 text-sm outline-none font-mono"
  const inputStyle = { border: '1px solid var(--as-hairline)' }
  const labelCls = "text-xs font-medium mb-1 block"
  const labelStyle = { color: 'var(--as-ink-80)' }

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 border-b flex items-center shrink-0"
        style={{ borderColor: 'var(--as-hairline)', height: 'var(--as-bar-h)', background: 'var(--as-parchment)' }}>
        <h2 className="text-lg font-semibold tracking-tight flex-1" style={{ color: 'var(--as-ink)' }}>{t('skills.title')}</h2>
        <span className="text-xs mr-3" style={{ color: 'var(--as-ink-48)' }}>{t('skills.hint.pathManagement')}</span>
        {isAdmin && (
          <button onClick={openDialog} className="as-btn as-btn-primary as-btn-sm">{t('skills.button.add')}</button>
        )}
      </div>

      <div className="px-6 py-3 border-b flex items-center gap-3" style={{ borderColor: 'var(--as-hairline)' }}>
        <Search size={14} style={{ color: 'var(--as-ink-48)' }} />
        <input
          placeholder={t('skills.search.placeholder')}
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(0) }}
          className="flex-1 outline-none text-sm bg-transparent"
          style={{ color: 'var(--as-ink)' }}
        />
        <span className="text-xs" style={{ color: 'var(--as-ink-48)' }}>{t('skills.search.count', { count: filtered.length })}</span>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-2">
        {isLoading && <p className="text-sm" style={{ color: 'var(--as-ink-48)' }}>{t('common.status.loading')}</p>}

        {paged.map((s) => (
          <div key={s.path} className="flex items-center gap-3 p-3 rounded-[var(--as-r-md)] bg-white transition-colors cursor-pointer hover:bg-[var(--as-parchment)]"
            style={{ border: '1px solid var(--as-hairline)', opacity: s.is_enabled ? 1 : 0.55 }}
            onClick={() => setPreviewSkill(s)}>
            <ToggleBtn path={s.path} is_enabled={s.is_enabled} />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate"
                style={{ color: s.is_enabled ? 'var(--as-ink)' : 'var(--as-ink-48)' }}>
                {s.name}
              </p>
              <p className="text-xs truncate font-mono mt-0.5" style={{ color: 'var(--as-ink-48)' }}>{s.path}</p>
            </div>
            <Eye size={15} className="shrink-0" style={{ color: 'var(--as-ink-48)' }} />
          </div>
        ))}

        {!isLoading && !paged.length && (
          <p className="text-sm" style={{ color: 'var(--as-ink-48)' }}>
            {!filtered.length
              ? t('skills.empty.noSkills')
              : t('skills.empty.noMatch')}
          </p>
        )}

        {filtered.length > PAGE && (
          <div className="flex items-center gap-3 pt-2">
            <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
              className="text-xs px-2 py-1 border rounded disabled:opacity-40"
              style={{ borderColor: 'var(--as-hairline)' }}>{t('common.pagination.prev')}</button>
            <span className="text-xs" style={{ color: 'var(--as-ink-48)' }}>{page + 1} / {totalPages}</span>
            <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
              className="text-xs px-2 py-1 border rounded disabled:opacity-40"
              style={{ borderColor: 'var(--as-hairline)' }}>{t('common.pagination.next')}</button>
          </div>
        )}
      </div>

      {previewSkill && (
        <SkillPreviewModal
          skill={previewSkill}
          isAdmin={isAdmin}
          onClose={() => setPreviewSkill(null)}
        />
      )}

      {showAdd && (
        <div className="as-overlay">
          <div className="as-dialog" style={{ minWidth: 480 }}>
            <h3 className="text-base font-semibold">{t('skills.dialog.install')}</h3>

            <div>
              <label className={labelCls} style={labelStyle}>{t('skills.install.targetDir')}</label>
              {dirs.length === 0 ? (
                <p className="text-xs" style={{ color: 'rgb(185,28,28)' }}>{t('skills.install.noDirs')}</p>
              ) : (
                <select className={inputCls} style={inputStyle} value={effectiveTarget}
                  onChange={e => setTargetDir(e.target.value)} disabled={dirs.length === 1}>
                  {dirs.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              )}
            </div>

            <div>
              <label className={labelCls} style={labelStyle}>Command</label>
              <input className={inputCls} style={inputStyle}
                placeholder={t('skills.install.placeholder')}
                value={command}
                onChange={e => { setCommand(e.target.value); if (result) setResult(null) }}
                autoFocus />
            </div>

            {(installMut.isPending || result) && (
              <div className="text-xs rounded px-3 py-2 flex items-start gap-2"
                style={{
                  background: installMut.isPending ? 'var(--as-parchment)'
                    : result?.ok ? 'rgba(34,197,94,0.08)' : 'rgba(220,38,38,0.08)',
                  border: '1px solid',
                  borderColor: installMut.isPending ? 'var(--as-hairline)'
                    : result?.ok ? 'rgba(34,197,94,0.4)' : 'rgba(220,38,38,0.4)',
                  color: installMut.isPending ? 'var(--as-ink-80)'
                    : result?.ok ? 'rgb(21,128,61)' : 'rgb(185,28,28)',
                }}>
                {installMut.isPending ? <Loader2 size={14} className="animate-spin shrink-0 mt-0.5" />
                  : result?.ok ? <CheckCircle2 size={14} className="shrink-0 mt-0.5" />
                  : <XCircle size={14} className="shrink-0 mt-0.5" />}
                <span className="flex-1 break-words">
                  {installMut.isPending && t('skills.install.running')}
                  {!installMut.isPending && result?.ok && (
                    result.skills?.length
                      ? t('skills.install.success', { names: result.skills.map(s => s.name).join(', ') })
                      : t('skills.install.noSkillFound')
                  )}
                  {!installMut.isPending && result && !result.ok && (
                    <span title={result.error}>{t('skills.install.failed', { message: result.error ?? t('common.error.unknown') })}</span>
                  )}
                </span>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button onClick={closeDialog} className="px-4 py-2 text-sm" style={{ color: 'var(--as-ink-80)' }}>{t('common.button.cancel')}</button>
              <button onClick={() => installMut.mutate()} disabled={!canInstall}
                className="as-btn as-btn-primary">
                {installMut.isPending ? t('common.status.saving') : t('skills.dialog.install')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Skill preview/edit modal — renders SKILL.md as markdown, with an admin-only
// edit mode that swaps in a textarea and writes back to disk on save.
// ─────────────────────────────────────────────────────────────────────────────

function SkillPreviewModal({ skill, isAdmin, onClose }: {
  skill: SkillDef
  isAdmin: boolean
  onClose: () => void
}) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)

  const { data, isLoading, error } = useQuery({
    queryKey: ['skill-content', skill.path],
    queryFn: () => webuiApi.getSkillContent(skill.path),
    retry: false,
  })

  // Load fetched content into local editor state. Respects user edits: once
  // the user has touched the textarea (dirty), we don't clobber their text.
  useEffect(() => {
    if (data && !dirty) setContent(data.content)
  }, [data, dirty])

  const saveMut = useMutation({
    mutationFn: () => webuiApi.writeSkillContent(skill.path, content),
    onSuccess: () => {
      setDirty(false); setEditing(false)
      qc.invalidateQueries({ queryKey: ['skill-content', skill.path] })
      qc.invalidateQueries({ queryKey: ['skill-lib'] })
    },
  })

  const loadedContent = data?.content ?? ''
  const readError = error ? ((error as any)?.response?.data?.detail ?? t('common.error.requestFailed')) : null

  return (
    <div className="as-overlay" onClick={onClose}>
      <div className="as-dialog flex flex-col" style={{ maxWidth: 820, width: '92vw', maxHeight: '88vh' }}
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-3 shrink-0">
          <h3 className="text-base font-semibold flex-1 truncate" style={{ color: 'var(--as-ink)' }}>{skill.name}</h3>
          <button onClick={onClose} className="as-btn as-btn-ghost as-btn-sm" style={{ padding: '4px' }}>
            <X size={15} />
          </button>
        </div>
        <p className="text-xs font-mono truncate mb-3 shrink-0" style={{ color: 'var(--as-ink-48)' }}>{skill.path}</p>

        <div className="flex items-center justify-end gap-2 mb-2 shrink-0">
          {editing ? (
            <>
              <button onClick={() => { setEditing(false); setDirty(false); setContent(loadedContent) }}
                className="as-btn as-btn-ghost as-btn-sm">{t('common.button.cancel')}</button>
              <button onClick={() => saveMut.mutate()} disabled={!dirty || saveMut.isPending}
                className="as-btn as-btn-primary as-btn-sm">
                {saveMut.isPending ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                <span className="ml-1">{t('skills.preview.save')}</span>
              </button>
            </>
          ) : (
            isAdmin && (
              <button onClick={() => setEditing(true)} className="as-btn as-btn-ghost as-btn-sm">
                <Pencil size={12} /> <span className="ml-1">{t('skills.preview.edit')}</span>
              </button>
            )
          )}
        </div>

        <div className="flex-1 overflow-y-auto rounded-[var(--as-r-sm)]"
          style={{ border: '1px solid var(--as-hairline)', background: 'var(--as-canvas)' }}>
          {isLoading ? (
            <div className="flex items-center justify-center h-full p-6">
              <Loader2 size={20} className="animate-spin" style={{ color: 'var(--as-ink-48)' }} />
            </div>
          ) : readError ? (
            <div className="p-6 text-sm text-center" style={{ color: 'rgb(185,28,28)' }}>{String(readError)}</div>
          ) : editing ? (
            <textarea
              value={content}
              onChange={e => { setContent(e.target.value); setDirty(true) }}
              spellCheck={false}
              className="w-full h-full resize-none outline-none p-4 font-mono text-sm"
              style={{ background: 'var(--as-canvas)', color: 'var(--as-ink)', border: 'none', minHeight: 320 }}
            />
          ) : (
            <div className="as-markdown p-4">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
            </div>
          )}
        </div>

        {saveMut.isError && (
          <p className="text-xs mt-2 shrink-0" style={{ color: 'rgb(185,28,28)' }}>
            {(saveMut.error as any)?.response?.data?.detail ?? t('common.error.requestFailed')}
          </p>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Enable/disable toggle (kept as its own component to preserve the original
// mutation wiring without re-deriving the query client in the list map).
// ─────────────────────────────────────────────────────────────────────────────

function ToggleBtn({ path, is_enabled }: { path: string; is_enabled: boolean }) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const toggleMut = useMutation({
    mutationFn: ({ path, is_enabled }: { path: string; is_enabled: boolean }) =>
      webuiApi.toggleSkill(path, is_enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['skill-lib'] }),
  })
  return (
    <button
      onClick={(e) => { e.stopPropagation(); toggleMut.mutate({ path, is_enabled: !is_enabled }) }}
      disabled={toggleMut.isPending}
      className="shrink-0 px-2.5 py-0.5 rounded-full text-xs font-medium transition-colors disabled:opacity-50"
      style={is_enabled
        ? { background: 'var(--as-primary)', color: '#fff' }
        : { background: 'var(--as-hairline)', color: 'var(--as-ink-48)' }}>
      {is_enabled ? t('skills.badge.enabled') : t('skills.badge.disabled')}
    </button>
  )
}
