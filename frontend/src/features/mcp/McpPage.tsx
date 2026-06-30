import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { webuiApi, type McpDef, type McpTestResult } from '@/api/webui'
import { Trash2, ChevronRight, CheckCircle2, XCircle, Loader2 } from 'lucide-react'

const PAGE = 8
const EMPTY = { name: '', transport: 'stdio', command: '', args: '', url: '', is_enabled: true }

// Mirror the backend's required-field rules so Test/Save can be gated consistently.
function formToMcpDef(form: typeof EMPTY): McpDef {
  return {
    name: form.name.trim(),
    transport: form.transport,
    command: form.command,
    args: form.args.split(' ').filter(Boolean),
    url: form.url,
    is_enabled: true,
  }
}

function isFormValid(form: typeof EMPTY): boolean {
  if (!form.name.trim()) return false
  if (form.transport === 'stdio') return !!form.command.trim()
  return !!form.url.trim()
}

export default function McpPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState(EMPTY)
  const [page, setPage] = useState(0)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<McpTestResult | null>(null)

  const { data: mcps = [], isLoading } = useQuery({ queryKey: ['mcp-lib'], queryFn: webuiApi.getMcpLib })

  const addMut = useMutation({
    mutationFn: () => webuiApi.addMcp(formToMcpDef(form)),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['mcp-lib'] }); closeDialog() },
  })
  const toggleMut = useMutation({
    mutationFn: ({ name, is_enabled }: { name: string; is_enabled: boolean }) => webuiApi.toggleMcp(name, is_enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mcp-lib'] }),
  })
  const deleteMut = useMutation({
    mutationFn: (name: string) => webuiApi.deleteMcp(name),
    onSuccess: (_d, name) => {
      qc.invalidateQueries({ queryKey: ['mcp-lib'] })
      if (expanded === name) setExpanded(null)
    },
  })
  const testMut = useMutation({
    mutationFn: () => webuiApi.testMcp(formToMcpDef(form)),
    onSuccess: (data) => setTestResult(data),
    onError: (err: any) => setTestResult({ ok: false, error: err?.message ?? t('common.error.requestFailed') }),
  })

  const closeDialog = () => {
    setShowAdd(false)
    setForm(EMPTY)
    setTestResult(null)
    testMut.reset()
  }

  const f = (key: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setForm(prev => ({ ...prev, [key]: e.target.value }))
    if (testResult) setTestResult(null)   // edits invalidate prior probe
  }
  const inputCls = "w-full rounded-[var(--as-r-sm)] px-3 py-2 text-sm outline-none"
  const inputStyle = { border: '1px solid var(--as-hairline)' }

  const list = mcps as McpDef[]
  const totalPages = Math.max(1, Math.ceil(list.length / PAGE))
  const paged = list.slice(page * PAGE, (page + 1) * PAGE)
  const formValid = isFormValid(form)

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 border-b flex items-center shrink-0" style={{ borderColor: 'var(--as-hairline)', height: 'var(--as-bar-h)', background: 'var(--as-parchment)' }}>
        <h2 className="text-lg font-semibold tracking-tight flex-1" style={{ color: 'var(--as-ink)' }}>{t('mcp.title')}</h2>
        <button onClick={() => setShowAdd(true)} className="as-btn as-btn-primary as-btn-sm">{t('mcp.button.register')}</button>
      </div>
      <div className="flex-1 overflow-y-auto p-6 space-y-2">
        {isLoading && <p className="text-sm" style={{ color: 'var(--as-ink-48)' }}>{t('common.status.loading')}</p>}
        {paged.map((m) => (
          <McpCard
            key={m.name}
            mcp={m}
            isExpanded={expanded === m.name}
            onToggleExpand={() => setExpanded(expanded === m.name ? null : m.name)}
            onToggleEnabled={(is_enabled) => toggleMut.mutate({ name: m.name, is_enabled })}
            onDelete={() => deleteMut.mutate(m.name)}
          />
        ))}
        {!isLoading && !list.length && <p className="text-sm" style={{ color: 'var(--as-ink-48)' }}>{t('mcp.empty.noServers')}</p>}
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
            <h3 className="text-base font-semibold">{t('mcp.dialog.register')}</h3>
            <input className={inputCls} style={inputStyle} placeholder={t('mcp.form.namePlaceholder')} value={form.name} onChange={f('name')} />
            <select className={inputCls} style={inputStyle} value={form.transport} onChange={f('transport')}>
              <option value="stdio">{t('term.transport.stdio')}</option>
              <option value="sse">{t('term.transport.sse')}</option>
              <option value="streamable-http">{t('term.transport.streamableHttp')}</option>
            </select>
            {form.transport === 'stdio' ? (
              <>
                <input className={inputCls} style={inputStyle} placeholder={t('mcp.form.commandPlaceholder')} value={form.command} onChange={f('command')} />
                <input className={inputCls} style={inputStyle} placeholder={t('mcp.form.argsPlaceholder')} value={form.args} onChange={f('args')} />
              </>
            ) : (
              <input className={inputCls} style={inputStyle} placeholder={t('mcp.form.urlPlaceholder')} value={form.url} onChange={f('url')} />
            )}

            {(testMut.isPending || testResult) && (
              <div className="text-xs rounded px-3 py-2 flex items-start gap-2"
                style={{
                  background: testMut.isPending ? 'var(--as-parchment)'
                    : testResult?.ok ? 'rgba(34,197,94,0.08)' : 'rgba(220,38,38,0.08)',
                  border: '1px solid',
                  borderColor: testMut.isPending ? 'var(--as-hairline)'
                    : testResult?.ok ? 'rgba(34,197,94,0.4)' : 'rgba(220,38,38,0.4)',
                  color: testMut.isPending ? 'var(--as-ink-80)'
                    : testResult?.ok ? 'rgb(21,128,61)' : 'rgb(185,28,28)',
                }}>
                {testMut.isPending ? <Loader2 size={14} className="animate-spin shrink-0 mt-0.5" />
                  : testResult?.ok ? <CheckCircle2 size={14} className="shrink-0 mt-0.5" />
                  : <XCircle size={14} className="shrink-0 mt-0.5" />}
                <span className="flex-1 break-words">
                  {testMut.isPending && (form.transport === 'stdio' ? t('mcp.test.probingStdio') : t('mcp.test.probing'))}
                  {!testMut.isPending && testResult?.ok && t('mcp.test.success', { count: testResult.tool_count ?? 0 })}
                  {!testMut.isPending && testResult && !testResult.ok && (
                    <span title={testResult.error}>{t('mcp.test.failed', { message: testResult.error ?? t('common.error.unknown') })}</span>
                  )}
                </span>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button onClick={closeDialog} className="px-4 py-2 text-sm" style={{ color: 'var(--as-ink-80)' }}>{t('common.button.cancel')}</button>
              <button onClick={() => testMut.mutate()} disabled={!formValid || testMut.isPending}
                className="as-btn as-btn-sm" style={{ border: '1px solid var(--as-hairline)' }}>
                {testMut.isPending ? t('mcp.button.testing') : t('mcp.button.test')}
              </button>
              <button onClick={() => addMut.mutate()} disabled={!formValid || addMut.isPending}
                className="as-btn as-btn-primary">
                {addMut.isPending ? t('common.status.saving') : t('common.button.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Card with expand-to-show-tools
// ─────────────────────────────────────────────────────────────────────────────

interface McpCardProps {
  mcp: McpDef
  isExpanded: boolean
  onToggleExpand: () => void
  onToggleEnabled: (is_enabled: boolean) => void
  onDelete: () => void
}

function McpCard({ mcp, isExpanded, onToggleExpand, onToggleEnabled, onDelete }: McpCardProps) {
  const { t } = useTranslation()
  const toolsQuery = useQuery({
    queryKey: ['mcp-tools', mcp.name, mcp.transport, mcp.url, mcp.command, mcp.args.join(' ')],
    queryFn: () => webuiApi.testMcp(mcp),
    enabled: isExpanded,
    staleTime: 60_000,
    retry: false,
  })

  return (
    <div className="as-card as-card-hover overflow-hidden">
      <div className="flex items-center gap-3 p-4 cursor-pointer" onClick={onToggleExpand}>
        <input type="checkbox" checked={mcp.is_enabled}
          onChange={e => onToggleEnabled(e.target.checked)}
          onClick={e => e.stopPropagation()}
          style={{ accentColor: 'var(--as-primary)' }} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium" style={{ color: 'var(--as-ink)' }}>{mcp.name}</p>
          <p className="text-xs truncate mt-0.5" style={{ color: 'var(--as-ink-48)' }}>
            {mcp.transport === 'stdio' ? `${mcp.command} ${mcp.args?.join(' ')}` : mcp.url}
          </p>
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded mt-1 inline-block" style={{ background: 'var(--as-parchment)', color: 'var(--as-ink-48)' }}>{mcp.transport === 'streamable-http' ? t('term.transport.streamableHttp') : t('term.transport.' + mcp.transport as any)}</span>
        </div>
        <ChevronRight size={16} className="shrink-0"
          style={{
            color: 'var(--as-ink-48)',
            transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 200ms',
          }} />
        <button onClick={e => { e.stopPropagation(); onDelete() }} className="as-btn as-btn-danger"><Trash2 size={13} /></button>
      </div>

      {isExpanded && (
        <div className="border-t px-4 py-3" style={{ borderColor: 'var(--as-hairline)', background: 'var(--as-parchment)' }}>
          {toolsQuery.isLoading && (
            <p className="text-xs flex items-center gap-2" style={{ color: 'var(--as-ink-48)' }}>
              <Loader2 size={12} className="animate-spin" />
              {t('mcp.card.loadingTools', { suffix: mcp.transport === 'stdio' ? t('mcp.card.stdioNote') : '' })}
            </p>
          )}
          {toolsQuery.isError && (
            <p className="text-xs" style={{ color: 'rgb(185,28,28)' }}>{t('mcp.card.failedToLoad', { message: (toolsQuery.error as any)?.message ?? t('common.error.requestFailed') })}</p>
          )}
          {toolsQuery.data && !toolsQuery.data.ok && (
            <p className="text-xs" style={{ color: 'rgb(185,28,28)' }} title={toolsQuery.data.error}>
              {t('mcp.card.failedToLoad', { message: toolsQuery.data.error ?? t('common.error.unknown') })}
            </p>
          )}
          {toolsQuery.data?.ok && toolsQuery.data.tools && (
            toolsQuery.data.tools.length === 0
              ? <p className="text-xs" style={{ color: 'var(--as-ink-48)' }}>{t('mcp.card.noTools')}</p>
              : <ul className="space-y-1.5 max-h-[280px] overflow-y-auto">
                  {toolsQuery.data.tools.map(t => (
                    <li key={t.name} className="text-xs">
                      <span className="font-mono font-medium" style={{ color: 'var(--as-ink)' }}>{t.name}</span>
                      {t.description && (
                        <span className="ml-2 truncate" style={{ color: 'var(--as-ink-48)' }} title={t.description}>
                          — {t.description}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
          )}
        </div>
      )}
    </div>
  )
}
