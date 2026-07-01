import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { webuiApi, type McpDef, type McpTransport, type McpAuthType, type McpTestResult } from '@/api/webui'
import { useAuthStore } from '@/store/auth'
import { Trash2, ChevronRight, CheckCircle2, XCircle, Loader2, Lock, Eye, EyeOff } from 'lucide-react'

const PAGE = 8

type FormState = {
  name: string
  transport: McpTransport
  command: string
  args: string
  url: string
  is_stateful: boolean
  auth_type: McpAuthType
  auth_token: string
  auth_header_name: string
}

// Non-admins can't use stdio (runs commands on the server host → RCE).
const REMOTE_DEFAULT: McpTransport = 'sse'

function buildEmpty(isAdmin: boolean): FormState {
  return {
    name: '',
    transport: isAdmin ? 'stdio' : REMOTE_DEFAULT,
    command: '',
    args: '',
    url: '',
    is_stateful: true,
    auth_type: 'none',
    auth_token: '',
    auth_header_name: '',
  }
}

// Mirror the backend's required-field rules so Test/Save can be gated consistently.
function formToMcpDef(form: FormState): McpDef {
  return {
    name: form.name.trim(),
    transport: form.transport,
    command: form.command,
    args: form.args.split(' ').filter(Boolean),
    url: form.url,
    is_stateful: form.is_stateful,
    is_enabled: true,
    auth_type: form.auth_type,
    auth_token: form.auth_token,
    auth_header_name: form.auth_header_name,
  }
}

function isFormValid(form: FormState): boolean {
  if (!form.name.trim()) return false
  if (form.transport === 'stdio') return !!form.command.trim()
  return !!form.url.trim()
}

// Static key lookup — avoids a dynamic t() key the typed i18n layer can't verify.
const transportLabel = (tr: McpTransport, t: TFunction): string => {
  if (tr === 'streamable-http') return t('term.transport.streamableHttp')
  if (tr === 'stdio') return t('term.transport.stdio')
  return t('term.transport.sse')
}

export default function McpPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const role = useAuthStore(s => s.role)
  const isAdmin = role === 'admin'

  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState<FormState>(() => buildEmpty(isAdmin))
  const [page, setPage] = useState(0)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<McpTestResult | null>(null)
  const [showToken, setShowToken] = useState(false)

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
    onError: (err: unknown) => setTestResult({ ok: false, error: err instanceof Error ? err.message : t('common.error.requestFailed') }),
  })

  const closeDialog = () => {
    setShowAdd(false)
    setForm(buildEmpty(isAdmin))
    setTestResult(null)
    setShowToken(false)
    testMut.reset()
  }

  // String fields share one handler; union-typed selects get their own so the
  // value is cast to the right literal type (selects only emit those values).
  const setStr = (key: 'name' | 'command' | 'args' | 'url' | 'auth_token' | 'auth_header_name') =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      setForm(prev => ({ ...prev, [key]: e.target.value }))
      if (testResult) setTestResult(null)   // edits invalidate prior probe
    }
  const setTransport = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setForm(prev => ({ ...prev, transport: e.target.value as McpTransport }))
    if (testResult) setTestResult(null)
  }
  const setAuthType = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setForm(prev => ({ ...prev, auth_type: e.target.value as McpAuthType }))
    if (testResult) setTestResult(null)
  }

  const inputCls = "w-full rounded-[var(--as-r-sm)] px-3 py-2 text-sm outline-none"
  const inputStyle = { border: '1px solid var(--as-hairline)' }
  const labelCls = "text-xs font-medium mb-1 block"
  const labelStyle = { color: 'var(--as-ink-80)' }

  const list = mcps as McpDef[]
  const totalPages = Math.max(1, Math.ceil(list.length / PAGE))
  const paged = list.slice(page * PAGE, (page + 1) * PAGE)
  const formValid = isFormValid(form)
  const isRemote = form.transport !== 'stdio'

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 border-b flex items-center shrink-0" style={{ borderColor: 'var(--as-hairline)', height: 'var(--as-bar-h)', background: 'var(--as-parchment)' }}>
        <h2 className="text-lg font-semibold tracking-tight flex-1" style={{ color: 'var(--as-ink)' }}>{t('mcp.title')}</h2>
        <button onClick={() => { setForm(buildEmpty(isAdmin)); setShowAdd(true) }} className="as-btn as-btn-primary as-btn-sm">{t('mcp.button.register')}</button>
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
          <div className="as-dialog" style={{ minWidth: 460 }}>
            <h3 className="text-base font-semibold">{t('mcp.dialog.register')}</h3>

            <div>
              <label className={labelCls} style={labelStyle}>{t('mcp.form.namePlaceholder')}</label>
              <input className={inputCls} style={inputStyle} placeholder={t('mcp.form.namePlaceholder')} value={form.name} onChange={setStr('name')} />
            </div>

            <div>
              <label className={labelCls} style={labelStyle}>{t('mcp.form.transport')}</label>
              <select className={inputCls} style={inputStyle} value={form.transport} onChange={setTransport}>
                {isAdmin && <option value="stdio">{t('term.transport.stdio')}</option>}
                <option value="sse">{t('term.transport.sse')}</option>
                <option value="streamable-http">{t('term.transport.streamableHttp')}</option>
              </select>
              {!isAdmin && form.transport === 'stdio' && (
                <p className="text-xs mt-1" style={{ color: 'rgb(185,28,28)' }}>{t('mcp.form.stdioAdminOnly')}</p>
              )}
            </div>

            {form.transport === 'stdio' ? (
              <>
                <div>
                  <label className={labelCls} style={labelStyle}>{t('mcp.form.commandPlaceholder')}</label>
                  <input className={inputCls} style={inputStyle} placeholder={t('mcp.form.commandPlaceholder')} value={form.command} onChange={setStr('command')} />
                </div>
                <div>
                  <label className={labelCls} style={labelStyle}>{t('mcp.form.argsPlaceholder')}</label>
                  <input className={inputCls} style={inputStyle} placeholder={t('mcp.form.argsPlaceholder')} value={form.args} onChange={setStr('args')} />
                </div>
                <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--as-ink-80)' }}>
                  <input type="checkbox" checked={form.is_stateful}
                    onChange={e => setForm(prev => ({ ...prev, is_stateful: e.target.checked }))}
                    style={{ accentColor: 'var(--as-primary)' }} />
                  {t('mcp.form.stateful')}
                </label>
              </>
            ) : (
              <div>
                <label className={labelCls} style={labelStyle}>URL</label>
                <input className={inputCls} style={inputStyle} placeholder={t('mcp.form.urlPlaceholder')} value={form.url} onChange={setStr('url')} />
              </div>
            )}

            {isRemote && (
              <div className="border-t pt-3" style={{ borderColor: 'var(--as-hairline)' }}>
                <label className={labelCls} style={labelStyle}>{t('mcp.auth.title')}</label>
                <select className={inputCls} style={inputStyle} value={form.auth_type} onChange={setAuthType}>
                  <option value="none">{t('mcp.auth.none')}</option>
                  <option value="bearer">{t('mcp.auth.bearer')}</option>
                  <option value="api_key">{t('mcp.auth.apiKey')}</option>
                  <option value="oauth">{t('mcp.auth.oauth')}</option>
                </select>

                {form.auth_type !== 'none' && (
                  <div className="mt-2">
                    <div className="relative">
                      <input
                        type={showToken ? 'text' : 'password'}
                        className={inputCls} style={inputStyle}
                        placeholder={t('mcp.auth.tokenPlaceholder')}
                        value={form.auth_token}
                        onChange={setStr('auth_token')}
                      />
                      <button type="button" onClick={() => setShowToken(v => !v)}
                        className="absolute right-2 top-1/2 -translate-y-1/2"
                        style={{ color: 'var(--as-ink-48)' }}>
                        {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                    {form.auth_type === 'api_key' && (
                      <input className={`${inputCls} mt-2`} style={inputStyle}
                        placeholder={t('mcp.auth.headerNamePlaceholder')}
                        value={form.auth_header_name}
                        onChange={setStr('auth_header_name')} />
                    )}
                    {form.auth_type === 'oauth' && (
                      <p className="text-xs mt-1" style={{ color: 'var(--as-ink-48)' }}>{t('mcp.auth.oauthHint')}</p>
                    )}
                  </div>
                )}
              </div>
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
              <button onClick={() => testMut.mutate()} disabled={!formValid || testMut.isPending || (form.transport === 'stdio' && !isAdmin)}
                className="as-btn as-btn-sm" style={{ border: '1px solid var(--as-hairline)' }}>
                {testMut.isPending ? t('mcp.button.testing') : t('mcp.button.test')}
              </button>
              <button onClick={() => addMut.mutate()} disabled={!formValid || addMut.isPending || (form.transport === 'stdio' && !isAdmin)}
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
  // Re-test via the name-based endpoint: GET /mcp-lib strips auth_token, so the
  // server resolves the saved def (with secret) itself — the browser never
  // round-trips the token.
  const toolsQuery = useQuery({
    queryKey: ['mcp-tools', mcp.name],
    queryFn: () => webuiApi.testSavedMcp(mcp.name),
    enabled: isExpanded,
    staleTime: 60_000,
    retry: false,
  })

  const hasAuth = mcp.auth_type && mcp.auth_type !== 'none'

  return (
    <div className="as-card as-card-hover overflow-hidden">
      <div className="flex items-center gap-3 p-4 cursor-pointer" onClick={onToggleExpand}>
        <input type="checkbox" checked={mcp.is_enabled}
          onChange={e => onToggleEnabled(e.target.checked)}
          onClick={e => e.stopPropagation()}
          style={{ accentColor: 'var(--as-primary)' }} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="text-sm font-medium" style={{ color: 'var(--as-ink)' }}>{mcp.name}</p>
            {hasAuth && (
              <span title={t('mcp.auth.title')}><Lock size={11} style={{ color: 'var(--as-ink-48)' }} /></span>
            )}
          </div>
          <p className="text-xs truncate mt-0.5" style={{ color: 'var(--as-ink-48)' }}>
            {mcp.transport === 'stdio' ? `${mcp.command} ${mcp.args?.join(' ')}` : mcp.url}
          </p>
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded mt-1 inline-block" style={{ background: 'var(--as-parchment)', color: 'var(--as-ink-48)' }}>{transportLabel(mcp.transport, t)}</span>
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
            <p className="text-xs" style={{ color: 'rgb(185,28,28)' }}>{t('mcp.card.failedToLoad', { message: (toolsQuery.error as Error)?.message ?? t('common.error.requestFailed') })}</p>
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
                  {toolsQuery.data.tools.map(tool => (
                    <li key={tool.name} className="text-xs">
                      <span className="font-mono font-medium" style={{ color: 'var(--as-ink)' }}>{tool.name}</span>
                      {tool.description && (
                        <span className="ml-2 truncate" style={{ color: 'var(--as-ink-48)' }} title={tool.description}>
                          — {tool.description}
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
