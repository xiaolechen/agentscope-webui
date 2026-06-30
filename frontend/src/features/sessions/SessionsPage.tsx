import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { agentsApi, AgentRecord } from '@/api/agents'
import { sessionsApi, SessionRecord } from '@/api/sessions'
import { useAuthStore } from '@/store/auth'
import { useNavigate } from 'react-router-dom'
import { webuiApi } from '@/api/webui'
import { Pencil, Trash2, RefreshCw, Play } from 'lucide-react'
import { useTranslation } from 'react-i18next'

// Shared state for resuming a session from Sessions page → Chat page
export interface ResumeTarget {
  sessionId: string
  agentId: string
  sessionName: string
}

// Simple module-level store for resume intent

export default function SessionsPage() {
  const role = useAuthStore(s => s.role)
  const boundAgentIds = useAuthStore(s => s.boundAgentIds)
  const navigate = useNavigate()
  const { t } = useTranslation()
  const qc = useQueryClient()

  const [filterAgent, setFilterAgent] = useState('')
  const [page, setPage] = useState(0)
  const [renamingSession, setRenamingSession] = useState<SessionRecord | null>(null)
  const [renameText, setRenameText] = useState('')

  const { data: agents = [] } = useQuery({ queryKey: ['agents'], queryFn: agentsApi.list })
  const relevantAgents: AgentRecord[] = role === 'admin'
    ? agents
    : agents.filter(a => boundAgentIds.includes(a.id))

  const { data: sessions = [], isLoading, refetch } = useQuery({
    queryKey: ['sessions-all', relevantAgents.map(a => a.id).join(',')],
    queryFn: async () => {
      const all: (SessionRecord & { agent_name: string })[] = []
      for (const agent of relevantAgents) {
        // Get ownership filter for regular users
        const ownerInfo = await webuiApi.getMySessionIds(agent.id).catch(() => ({ all: true }))
        const allowedIds = (ownerInfo as any).all ? null : new Set((ownerInfo as any).session_ids ?? [])

        const list = await sessionsApi.listByAgent(agent.id).catch(() => [])
        const filtered = allowedIds ? list.filter(s => allowedIds.has(s.id)) : list
        filtered.forEach(s => all.push({ ...s, agent_name: agent.data.name }))
      }
      return all.sort((a, b) => (b.updated_at ?? '') > (a.updated_at ?? '') ? 1 : -1)
    },
    enabled: relevantAgents.length > 0,
  })

  const deleteMut = useMutation({
    mutationFn: (s: SessionRecord) => sessionsApi.delete(s.id, s.agent_id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions-all'] }),
  })

  const renameMut = useMutation({
    mutationFn: (s: SessionRecord) => sessionsApi.update(s.id, s.agent_id, { name: renameText }),
    onSuccess: () => { setRenamingSession(null); qc.invalidateQueries({ queryKey: ['sessions-all'] }) },
  })

  // Resume: navigate to /chat and pass session context via sessionStorage
  const resumeSession = (s: SessionRecord & { agent_name: string }) => {
    sessionStorage.setItem('resumeSession', JSON.stringify({
      sessionId: s.id,
      agentId: s.agent_id,
      sessionName: s.config.name,
    }))
    navigate('/chat')
  }

  const filtered = filterAgent ? sessions.filter(s => s.agent_id === filterAgent) : sessions
  const PAGE = 10
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE))
  const paged = filtered.slice(page * PAGE, (page + 1) * PAGE)

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 border-b flex items-center gap-4 shrink-0" style={{ borderColor: 'var(--as-hairline)', height: 'var(--as-bar-h)', background: 'var(--as-parchment)' }}>
        <h2 className="text-lg font-semibold tracking-tight" style={{ color: 'var(--as-ink)' }}>{t('sessions.title')}</h2>
        <select value={filterAgent} onChange={e => { setFilterAgent(e.target.value); setPage(0) }}
          className="text-sm rounded-[var(--as-r-sm)] px-2 py-1.5 bg-white outline-none ml-auto"
          style={{ border: '1px solid var(--as-hairline)' }}>
          <option value="">{t('sessions.filter.allAgents')}</option>
          {relevantAgents.map(a => <option key={a.id} value={a.id}>{a.data.name}</option>)}
        </select>
        <button onClick={() => refetch()} className="as-btn as-btn-ghost"><RefreshCw size={14} /></button>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-2">
        {isLoading && <p className="text-sm" style={{ color: 'var(--as-ink-48)' }}>{t('common.status.loading')}</p>}
        {!isLoading && filtered.length === 0 && (
          <p className="text-sm" style={{ color: 'var(--as-ink-48)' }}>{t('sessions.empty.noSessions')}</p>
        )}
        {paged.map(s => (
          <div key={s.id} className="as-card as-card-hover flex items-center gap-3 p-4">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate" style={{ color: 'var(--as-ink)' }}>{s.config.name}</p>
              <div className="flex items-center gap-3 mt-0.5">
                <span className="text-xs" style={{ color: 'var(--as-ink-48)' }}>{(s as any).agent_name}</span>
                {s.updated_at && (
                  <span className="text-xs" style={{ color: 'var(--as-ink-48)' }}>{s.updated_at.slice(0, 16).replace('T', ' ')}</span>
                )}
                <span className="text-[10px] font-mono" style={{ color: 'var(--as-ink-48)' }}>{s.id.slice(0, 8)}…</span>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {/* Resume session */}
              <button onClick={() => resumeSession(s as any)}
                className="flex items-center gap-1 px-2 py-1 text-xs rounded-[var(--as-r-sm)] transition-colors"
                style={{ color: 'var(--as-primary)', border: '1px solid var(--as-primary)' }}
                title={t('sessions.button.resumeTitle')}>
                <Play size={11} /> {t('sessions.button.resume')}
              </button>
              <button onClick={() => { setRenamingSession(s); setRenameText(s.config.name) }}
                className="as-btn as-btn-ghost"><Pencil size={13} /></button>
              <button onClick={() => { if (confirm(t('sessions.confirm.delete'))) deleteMut.mutate(s) }}
                className="as-btn as-btn-danger"><Trash2 size={13} /></button>
            </div>
          </div>
        ))}
      </div>

      {filtered.length > PAGE && (
        <div className="px-6 border-t flex items-center gap-3 shrink-0"
          style={{ borderColor: 'var(--as-hairline)', height: 'var(--as-footer-bar-h)', background: 'var(--as-parchment)' }}>
          <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}
            className="text-xs px-2 py-1 border rounded disabled:opacity-40" style={{ borderColor: 'var(--as-hairline)' }}>{t('common.pagination.prev')}</button>
          <span className="text-xs" style={{ color: 'var(--as-ink-48)' }}>{page + 1} / {totalPages}</span>
          <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
            className="text-xs px-2 py-1 border rounded disabled:opacity-40" style={{ borderColor: 'var(--as-hairline)' }}>{t('common.pagination.next')}</button>
          <span className="text-xs ml-auto" style={{ color: 'var(--as-ink-48)' }}>{t('common.pagination.total', { count: filtered.length })}</span>
        </div>
      )}

      {renamingSession && (
        <div className="as-overlay">
          <div className="as-dialog">
            <h3 className="text-base font-semibold">{t('sessions.dialog.rename')}</h3>
            <input value={renameText} onChange={e => setRenameText(e.target.value)}
              className="as-input" autoFocus
              onKeyDown={e => e.key === 'Enter' && renameMut.mutate(renamingSession)} />
            <div className="flex justify-end gap-2">
              <button onClick={() => setRenamingSession(null)} className="px-4 py-2 text-sm" style={{ color: 'var(--as-ink-80)' }}>{t('common.button.cancel')}</button>
              <button onClick={() => renameMut.mutate(renamingSession!)}
                className="px-4 py-2 text-white text-sm rounded-[var(--as-pill)]"
                style={{ background: 'var(--as-primary)' }}>{t('common.button.save')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
